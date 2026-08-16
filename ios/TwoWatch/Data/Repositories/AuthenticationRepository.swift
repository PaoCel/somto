import AuthenticationServices
import CryptoKit
@preconcurrency import FirebaseAuth
import FirebaseCore
import Foundation
import GoogleSignIn
import Security
import UIKit

@MainActor
final class AuthenticationRepository {
    private let auth = Auth.auth()
    private var currentAppleNonce: String?

    private final class CallablePayloadBox: @unchecked Sendable {
        let payload: NSDictionary

        init(_ payload: NSDictionary) {
            self.payload = payload
        }
    }

    func addStateListener(_ handler: @escaping (User?) -> Void) -> AuthStateDidChangeListenerHandle {
        auth.addStateDidChangeListener { _, user in
            handler(user)
        }
    }

    func removeListener(_ handle: AuthStateDidChangeListenerHandle) {
        auth.removeStateDidChangeListener(handle)
    }

    func signIn(email: String, password: String) async throws -> User {
        try await auth.signIn(withEmail: email, password: password).user
    }

    func signUp(email: String, password: String) async throws -> User {
        try await auth.createUser(withEmail: email, password: password).user
    }

    func resetPassword(email: String) async throws {
        try await auth.sendPasswordReset(withEmail: email)
    }

    /// Converte un errore di autenticazione (Firebase espone NSError tecnici in inglese)
    /// in un messaggio italiano leggibile. Evita di mostrare stringhe tipo
    /// "An error occurred when accessing the keychain. The NSLocalizedFailureReasonErrorKey…".
    nonisolated static func friendlyMessage(for error: Error) -> String {
        let nsError = error as NSError
        // Errori custom Google/Apple: hanno già un messaggio IT pronto.
        if nsError.domain == "TwoWatch" {
            return nsError.localizedDescription
        }
        if nsError.domain == "FIRAuthErrorDomain", let code = AuthErrorCode(rawValue: nsError.code) {
            switch code {
            case .invalidEmail:
                return String(localized: "Email non valida.")
            case .wrongPassword, .invalidCredential:
                return String(localized: "Email o password non corretti.")
            case .userNotFound:
                return String(localized: "Nessun account con questa email.")
            case .userDisabled:
                return String(localized: "Questo account è stato disabilitato.")
            case .emailAlreadyInUse:
                return String(localized: "Esiste già un account con questa email.")
            case .weakPassword:
                return "Password troppo debole: usa almeno 6 caratteri."
            case .networkError:
                return String(localized: "Connessione assente. Controlla la rete e riprova.")
            case .tooManyRequests:
                return "Troppi tentativi. Riprova tra qualche minuto."
            case .requiresRecentLogin:
                return String(localized: "Per sicurezza accedi di nuovo e riprova.")
            default:
                break
            }
        }
        return String(localized: "Qualcosa è andato storto. Riprova.")
    }

    var isGoogleSignInAvailable: Bool {
        resolvedGoogleClientID != nil
    }

    var isAppleSignInAvailable: Bool {
        true
    }

    func signInWithGoogle() async throws -> (user: User, isNewUser: Bool) {
        guard let clientID = resolvedGoogleClientID else {
            throw NSError(domain: "TwoWatch", code: 10, userInfo: [
                NSLocalizedDescriptionKey: String(localized: "Google Sign-In non è configurato nel bundle.")
            ])
        }

        guard let presentingViewController = topViewController() else {
            throw NSError(domain: "TwoWatch", code: 11, userInfo: [
                NSLocalizedDescriptionKey: String(localized: "Impossibile aprire il flusso Google Sign-In.")
            ])
        }

        GIDSignIn.sharedInstance.configuration = GIDConfiguration(clientID: clientID)

        let tokens = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<(String, String), Error>) in
            GIDSignIn.sharedInstance.signIn(withPresenting: presentingViewController) { result, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }

                guard
                    let result,
                    let idToken = result.user.idToken?.tokenString
                else {
                    continuation.resume(throwing: NSError(domain: "TwoWatch", code: 12, userInfo: [
                        NSLocalizedDescriptionKey: String(localized: "Google Sign-In non ha restituito un account valido.")
                    ]))
                    return
                }

                continuation.resume(returning: (idToken, result.user.accessToken.tokenString))
            }
        }

        let credential = GoogleAuthProvider.credential(withIDToken: tokens.0, accessToken: tokens.1)
        let authResult = try await auth.signIn(with: credential)
        return (authResult.user, authResult.additionalUserInfo?.isNewUser ?? false)
    }

    func prepareAppleSignInRequest(_ request: ASAuthorizationAppleIDRequest) {
        let nonce = randomNonceString()
        currentAppleNonce = nonce
        request.requestedScopes = [.fullName, .email]
        request.nonce = sha256(nonce)
    }

    func signInWithApple(result: Result<ASAuthorization, Error>) async throws -> (user: User, isNewUser: Bool) {
        defer {
            currentAppleNonce = nil
        }

        switch result {
        case .failure(let error):
            throw error
        case .success(let authorization):
            guard let appleCredential = authorization.credential as? ASAuthorizationAppleIDCredential else {
                throw NSError(domain: "TwoWatch", code: 13, userInfo: [
                    NSLocalizedDescriptionKey: String(localized: "Apple Sign-In non ha restituito credenziali valide.")
                ])
            }

            guard let nonce = currentAppleNonce else {
                throw NSError(domain: "TwoWatch", code: 14, userInfo: [
                    NSLocalizedDescriptionKey: String(localized: "Sessione Apple non valida. Riprova.")
                ])
            }

            guard let identityToken = appleCredential.identityToken,
                  let idTokenString = String(data: identityToken, encoding: .utf8)
            else {
                throw NSError(domain: "TwoWatch", code: 15, userInfo: [
                    NSLocalizedDescriptionKey: String(localized: "Apple Sign-In non ha restituito un token valido.")
                ])
            }

            let credential = OAuthProvider.appleCredential(
                withIDToken: idTokenString,
                rawNonce: nonce,
                fullName: appleCredential.fullName
            )

            let authResult = try await auth.signIn(with: credential)
            return (authResult.user, authResult.additionalUserInfo?.isNewUser ?? false)
        }
    }

    func signOut() throws {
        GIDSignIn.sharedInstance.signOut()
        try auth.signOut()
    }

    func deleteCurrentAccount() async throws {
        guard auth.currentUser != nil else {
            throw NSError(domain: "TwoWatch", code: 16, userInfo: [
                NSLocalizedDescriptionKey: String(localized: "Nessun account autenticato da eliminare.")
            ])
        }

        _ = try await invokeCallable(name: "deleteMyAccount", payload: ["confirm": true])

        GIDSignIn.sharedInstance.signOut()
        try? auth.signOut()
    }

    private var resolvedGoogleClientID: String? {
        if let clientID = FirebaseApp.app()?.options.clientID, !clientID.isEmpty {
            return clientID
        }

        guard let path = Bundle.main.path(forResource: "GoogleService-Info", ofType: "plist"),
              let payload = NSDictionary(contentsOfFile: path) as? [String: Any]
        else {
            return nil
        }

        return payload["CLIENT_ID"] as? String
    }

    private func topViewController(base: UIViewController? = nil) -> UIViewController? {
        let root = base ?? UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first(where: \.isKeyWindow)?
            .rootViewController

        if let navigationController = root as? UINavigationController {
            return topViewController(base: navigationController.visibleViewController)
        }

        if let tabBarController = root as? UITabBarController {
            return topViewController(base: tabBarController.selectedViewController)
        }

        if let presented = root?.presentedViewController {
            return topViewController(base: presented)
        }

        return root
    }

    private func invokeCallable(name: String, payload: [String: Any]) async throws -> CloudFunctionsCaller.CallableResult {
        try await CloudFunctionsCaller.call(name: name, data: payload)
    }

    private func sha256(_ input: String) -> String {
        let inputData = Data(input.utf8)
        let hashedData = SHA256.hash(data: inputData)
        return hashedData.map { String(format: "%02x", $0) }.joined()
    }

    private func randomNonceString(length: Int = 32) -> String {
        precondition(length > 0)
        let charset: [Character] = Array("0123456789ABCDEFGHIJKLMNOPQRSTUVXYZabcdefghijklmnopqrstuvwxyz-._")
        var result = ""
        result.reserveCapacity(length)

        var remainingLength = length
        while remainingLength > 0 {
            var randoms = [UInt8](repeating: 0, count: 16)
            let errorCode = SecRandomCopyBytes(kSecRandomDefault, randoms.count, &randoms)

            if errorCode != errSecSuccess {
                fatalError("Impossibile generare un nonce sicuro. OSStatus \(errorCode)")
            }

            randoms.forEach { random in
                if remainingLength == 0 {
                    return
                }

                if random < charset.count {
                    result.append(charset[Int(random)])
                    remainingLength -= 1
                }
            }
        }

        return result
    }
}
