import FirebaseFirestore
import XCTest
@testable import Somto

/// Test sul FILTRO di `SilentFailure`.
///
/// Non si testa che Crashlytics riceva l'evento — quello e' l'SDK. Si testa
/// cosa viene scartato, perche' e' la parte che decide se il reporting sara'
/// utile o solo rumore: un reporter che manda tutto viene silenziato entro una
/// settimana, e a quel punto e' peggio di non averlo.
final class SilentFailureTests: XCTestCase {

    // MARK: - Da scartare

    /// Navigare via da una schermata cancella i suoi task: e' funzionamento
    /// normale, non un guasto.
    func testCancellationIsNotReported() {
        XCTAssertFalse(SilentFailure.isWorthReporting(CancellationError()))
    }

    func testURLCancellationIsNotReported() {
        let error = NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled)
        XCTAssertFalse(SilentFailure.isWorthReporting(error))
    }

    /// Un utente in metropolitana genererebbe decine di eventi al minuto, e non
    /// c'e' niente da correggere lato codice.
    func testOfflineErrorsAreNotReported() {
        let offline = [
            NSURLErrorNotConnectedToInternet,
            NSURLErrorNetworkConnectionLost,
            NSURLErrorTimedOut,
            NSURLErrorDataNotAllowed,
            NSURLErrorInternationalRoamingOff
        ]
        for code in offline {
            let error = NSError(domain: NSURLErrorDomain, code: code)
            XCTAssertFalse(
                SilentFailure.isWorthReporting(error),
                "il codice URL \(code) e' transitorio: non va segnalato"
            )
        }
    }

    func testTransientFirestoreErrorsAreNotReported() {
        let transient = [
            FirestoreErrorCode.cancelled.rawValue,
            FirestoreErrorCode.unavailable.rawValue,
            FirestoreErrorCode.deadlineExceeded.rawValue
        ]
        for code in transient {
            let error = NSError(domain: FirestoreErrorDomain, code: code)
            XCTAssertFalse(
                SilentFailure.isWorthReporting(error),
                "il codice Firestore \(code) e' transitorio: non va segnalato"
            )
        }
    }

    // MARK: - Da segnalare

    /// Il caso che questo strumento esiste per catturare: un permesso negato
    /// oggi produce una sezione vuota e nessuno lo sa. Vedi l'incidente del
    /// cambio account (2026-08-09).
    func testPermissionDeniedIsReported() {
        let error = NSError(
            domain: FirestoreErrorDomain,
            code: FirestoreErrorCode.permissionDenied.rawValue
        )
        XCTAssertTrue(SilentFailure.isWorthReporting(error))
    }

    func testMalformedDataIsReported() {
        let error = NSError(
            domain: FirestoreErrorDomain,
            code: FirestoreErrorCode.invalidArgument.rawValue
        )
        XCTAssertTrue(SilentFailure.isWorthReporting(error))
    }

    /// Un 500 del backend non e' "rete assente": e' qualcosa da guardare.
    func testServerErrorIsReported() {
        let error = NSError(domain: NSURLErrorDomain, code: NSURLErrorBadServerResponse)
        XCTAssertTrue(SilentFailure.isWorthReporting(error))
    }

    func testUnknownDomainIsReported() {
        let error = NSError(domain: "QualcosaDiNuovo", code: 42)
        XCTAssertTrue(
            SilentFailure.isWorthReporting(error),
            "in dubbio si segnala: meglio un evento in piu' che un guasto invisibile"
        )
    }
}
