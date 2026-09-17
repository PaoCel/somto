import XCTest
@testable import Somto

/// `CallableError` sta sull'unica strada che porta a ogni Cloud Function
/// dell'app, quindi la sua `errorDescription` e' potenzialmente la frase piu'
/// letta in assoluto quando qualcosa va storto.
///
/// La regressione da impedire e' documentata: fino al 2026-08-11 il caso
/// `.httpError` restituiva `"Errore HTTP \(code): \(body)"`, e siccome
/// `UserFacingError` da' la precedenza ai `LocalizedError` di dominio, quel
/// JSON finiva **in schermo**. Con gli App Intent finirebbe anche nella voce di
/// Siri.
final class CallableErrorTests: XCTestCase {

    private typealias CallableError = CloudFunctionsCaller.CallableError

    private func httpError(
        _ statusCode: Int,
        status: String? = nil,
        message: String? = nil,
        body: String = ""
    ) -> CallableError {
        .httpError(statusCode: statusCode, status: status, message: message, body: body)
    }

    // MARK: - Il body non deve mai arrivare all'utente

    func testResponseBodyNeverReachesTheUser() {
        let body = #"{"error":{"status":"INVALID_ARGUMENT","message":"titleId mancante."}}"#
        let error = httpError(400, status: "INVALID_ARGUMENT", message: "titleId mancante.", body: body)

        let shown = UserFacingError.message(for: error)

        XCTAssertFalse(shown.contains("titleId"))
        XCTAssertFalse(shown.contains("{"))
        XCTAssertFalse(shown.contains("Errore HTTP"))
        XCTAssertEqual(shown, UserFacingError.Kind.unexpected.message)
    }

    /// Il messaggio scritto da noi lato backend resta comunque interno: e'
    /// copy per sviluppatori ("titleId mancante."), non per chi usa l'app.
    func testBackendMessageIsNotUsedAsUserCopy() {
        let error = httpError(400, status: "INVALID_ARGUMENT", message: "titleId mancante.")
        XCTAssertNotEqual(UserFacingError.message(for: error), "titleId mancante.")
    }

    // MARK: - Classificazione

    func testGrpcStatusDrivesTheMessage() {
        XCTAssertEqual(UserFacingError.message(for: httpError(401, status: "UNAUTHENTICATED")),
                       UserFacingError.Kind.signInAgain.message)
        XCTAssertEqual(UserFacingError.message(for: httpError(403, status: "PERMISSION_DENIED")),
                       UserFacingError.Kind.notAllowed.message)
        XCTAssertEqual(UserFacingError.message(for: httpError(404, status: "NOT_FOUND")),
                       UserFacingError.Kind.notFound.message)
        XCTAssertEqual(UserFacingError.message(for: httpError(503, status: "UNAVAILABLE")),
                       UserFacingError.Kind.offline.message)
    }

    /// `enforceCallableRateLimit` risponde `resource-exhausted`: e' il caso che
    /// un App Intent puo' incontrare davvero, perche' una scorciatoia in
    /// automazione ripete la stessa chiamata.
    func testRateLimitHasItsOwnPhrase() {
        XCTAssertEqual(UserFacingError.message(for: httpError(429, status: "RESOURCE_EXHAUSTED")),
                       UserFacingError.Kind.rateLimited.message)
    }

    /// L'envelope puo' mancare (proxy, gateway, 5xx grezzo): si ricade
    /// sull'HTTP status invece di finire tutti in "unexpected".
    func testFallsBackToHTTPStatusWhenTheEnvelopeIsMissing() {
        XCTAssertEqual(UserFacingError.message(for: httpError(429)), UserFacingError.Kind.rateLimited.message)
        XCTAssertEqual(UserFacingError.message(for: httpError(401)), UserFacingError.Kind.signInAgain.message)
        XCTAssertEqual(UserFacingError.message(for: httpError(500)), UserFacingError.Kind.unexpected.message)
    }

    func testMissingAuthTokenAsksForANewSignIn() {
        XCTAssertEqual(UserFacingError.message(for: CallableError.noAuthToken),
                       UserFacingError.Kind.signInAgain.message)
    }

    // MARK: - Il dettaglio sopravvive per il report

    /// L'altra meta' di §5.1: ripulire la frase per l'utente non deve
    /// cancellare la diagnosi. Se questo test cade, Crashlytics ricomincia a
    /// ricevere solo "Qualcosa è andato storto".
    func testDiagnosticKeepsWhatTheUserMessageDrops() {
        let body = #"{"error":{"status":"RESOURCE_EXHAUSTED","message":"Troppe richieste."}}"#
        let error = httpError(429, status: "RESOURCE_EXHAUSTED", message: "Troppe richieste.", body: body)

        let diagnostic = error.diagnosticDescription

        XCTAssertTrue(diagnostic.contains("429"))
        XCTAssertTrue(diagnostic.contains("RESOURCE_EXHAUSTED"))
        XCTAssertTrue(diagnostic.contains("Troppe richieste."))
    }

    /// Il body puo' essere enorme (una pagina HTML di errore del gateway): nel
    /// report va troncato, non riversato.
    func testDiagnosticTruncatesAHugeBody() {
        let error = httpError(500, body: String(repeating: "x", count: 5_000))
        XCTAssertLessThan(error.diagnosticDescription.count, 500)
    }
}
