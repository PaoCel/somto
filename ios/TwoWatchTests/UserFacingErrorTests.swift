import FirebaseFirestore
import XCTest
@testable import Somto

/// Il mapper sta fra un errore tecnico e ciò che legge l'utente. Se sbaglia
/// classificazione nessuno se ne accorge da un crash: si accorge un utente che
/// legge "Missing or insufficient permissions." e scrive all'assistenza.
final class UserFacingErrorTests: XCTestCase {

    private func firestoreError(_ code: Int) -> NSError {
        NSError(domain: FirestoreErrorDomain, code: code)
    }

    // MARK: - Classificazione

    func testFirestoreCodesMapToTheRightKind() {
        XCTAssertEqual(UserFacingError.kind(of: firestoreError(FirestoreErrorCode.permissionDenied.rawValue)), .notAllowed)
        XCTAssertEqual(UserFacingError.kind(of: firestoreError(FirestoreErrorCode.unauthenticated.rawValue)), .signInAgain)
        XCTAssertEqual(UserFacingError.kind(of: firestoreError(FirestoreErrorCode.notFound.rawValue)), .notFound)
        XCTAssertEqual(UserFacingError.kind(of: firestoreError(FirestoreErrorCode.unavailable.rawValue)), .offline)
        XCTAssertEqual(UserFacingError.kind(of: firestoreError(FirestoreErrorCode.deadlineExceeded.rawValue)), .offline)
        XCTAssertEqual(UserFacingError.kind(of: firestoreError(FirestoreErrorCode.aborted.rawValue)), .unexpected)
    }

    /// Functions e Firestore condividono i codici gRPC: stessa tabella.
    func testCloudFunctionsSharesTheFirestoreCodeTable() {
        let denied = NSError(
            domain: "com.firebase.functions",
            code: FirestoreErrorCode.permissionDenied.rawValue
        )
        XCTAssertEqual(UserFacingError.kind(of: denied), .notAllowed)
    }

    func testNetworkFailuresAreOffline() {
        XCTAssertEqual(UserFacingError.kind(of: URLError(.notConnectedToInternet)), .offline)
        XCTAssertEqual(UserFacingError.kind(of: URLError(.networkConnectionLost)), .offline)
        XCTAssertEqual(UserFacingError.kind(of: URLError(.timedOut)), .offline)
        XCTAssertEqual(UserFacingError.kind(of: URLError(.badURL)), .unexpected)
    }

    func testStaleAuthTokenAsksForANewSignIn() {
        let requiresRecentLogin = NSError(domain: "FIRAuthErrorDomain", code: 17_014)
        XCTAssertEqual(UserFacingError.kind(of: requiresRecentLogin), .signInAgain)
    }

    func testUnknownDomainsFallBackInsteadOfLeaking() {
        let opaque = NSError(domain: "SomeSDK", code: 42)
        XCTAssertEqual(UserFacingError.kind(of: opaque), .unexpected)
    }

    // MARK: - Messaggio

    /// La regressione da impedire: la stringa dell'SDK non deve mai arrivare
    /// in schermo.
    func testRawSDKTextNeverReachesTheUser() {
        let raw = NSError(
            domain: FirestoreErrorDomain,
            code: FirestoreErrorCode.permissionDenied.rawValue,
            userInfo: [NSLocalizedDescriptionKey: "Missing or insufficient permissions."]
        )

        let message = UserFacingError.message(for: raw)

        XCTAssertFalse(message.contains("Missing or insufficient permissions."))
        XCTAssertEqual(message, UserFacingError.Kind.notAllowed.message)
    }

    /// Gli errori di dominio dell'app hanno già una frase scritta da noi: il
    /// mapper non deve sostituirla con quella generica.
    func testDomainErrorsKeepTheirOwnWording() {
        struct DomainError: LocalizedError {
            var errorDescription: String? { "Questa lista non esiste più." }
        }

        XCTAssertEqual(UserFacingError.message(for: DomainError()), "Questa lista non esiste più.")
    }

    func testEveryKindHasNonEmptyCopy() {
        let kinds: [UserFacingError.Kind] = [.offline, .notAllowed, .signInAgain, .notFound, .rateLimited, .unexpected]
        for kind in kinds {
            XCTAssertFalse(kind.message.isEmpty, "\(kind)")
        }
    }
}
