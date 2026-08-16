@preconcurrency import FirebaseAuth
import Foundation

/// Calls Firebase Cloud Functions via direct HTTP POST, bypassing the Firebase Functions SDK
/// which has an `async let` crash in `HTTPSCallable.SendableHTTPSCallable.call()`.
enum CloudFunctionsCaller {

    struct CallableResult: @unchecked Sendable {
        let data: Any
    }

    enum CallableError: LocalizedError, DiagnosableError {
        case noAuthToken
        case invalidURL
        /// `status` e `message` vengono dall'envelope callable di Firebase
        /// (`{"error":{"status":…,"message":…}}`). `body` resta grezzo SOLO per
        /// la diagnostica.
        case httpError(statusCode: Int, status: String?, message: String?, body: String)
        case decodingError

        /// Cosa legge l'utente.
        ///
        /// PERCHE' NON C'E' PIU' IL BODY — `errorDescription` ha la precedenza
        /// dentro `UserFacingError.message(for:)` (i domini dell'app vincono
        /// sulla tabella generica), quindi il vecchio
        /// `"Errore HTTP \(code): \(body)"` finiva **in schermo**: JSON grezzo,
        /// in inglese, con dentro messaggi scritti per noi ("titleId
        /// mancante."). E' lo stesso difetto di §5.1 di
        /// docs/context/IOS_CODE_STYLE.md, in un punto che li attraversa tutti.
        /// Con gli App Intent peggiora ancora: Siri lo leggerebbe ad alta voce.
        var errorDescription: String? {
            switch self {
            case .noAuthToken:
                UserFacingError.Kind.signInAgain.message
            case .invalidURL, .decodingError:
                UserFacingError.Kind.unexpected.message
            case let .httpError(statusCode, status, _, _):
                Self.kind(statusCode: statusCode, status: status).message
            }
        }

        /// Cosa finisce in `SilentFailure`/Crashlytics: qui il dettaglio serve,
        /// ed e' l'unico posto in cui il body ha diritto di comparire.
        var diagnosticDescription: String {
            switch self {
            case .noAuthToken:
                "noAuthToken"
            case .invalidURL:
                "invalidURL"
            case .decodingError:
                "decodingError"
            case let .httpError(statusCode, status, message, body):
                "http \(statusCode) status=\(status ?? "-") message=\(message ?? "-") body=\(body.prefix(300))"
            }
        }

        /// Le Functions callable riportano i codici gRPC come stringa nello
        /// status, e l'HTTP status e' il loro riflesso: si guarda il primo e si
        /// ricade sul secondo quando l'envelope non e' quello atteso.
        private static func kind(statusCode: Int, status: String?) -> UserFacingError.Kind {
            switch status {
            case "UNAUTHENTICATED": return .signInAgain
            case "PERMISSION_DENIED": return .notAllowed
            case "NOT_FOUND": return .notFound
            case "RESOURCE_EXHAUSTED": return .rateLimited
            case "UNAVAILABLE", "DEADLINE_EXCEEDED": return .offline
            default: break
            }

            switch statusCode {
            case 401: return .signInAgain
            case 403: return .notAllowed
            case 404: return .notFound
            case 429: return .rateLimited
            case 503, 504: return .offline
            default: return .unexpected
            }
        }
    }

    private static let session: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 70
        config.timeoutIntervalForResource = 70
        return URLSession(configuration: config)
    }()

    @MainActor
    static func call(
        name: String,
        data payload: Any,
        region: String = FirebaseConfig.loadIfPresent()?.functionsRegion ?? "europe-west1",
        projectID: String = FirebaseConfig.loadIfPresent()?.projectID ?? ""
    ) async throws -> CallableResult {
        let token = try await currentAuthToken()
        let httpBody = try JSONSerialization.data(withJSONObject: ["data": payload])

        return try await performRequest(name: name, region: region, projectID: projectID, token: token, body: httpBody)
    }

    private nonisolated static func performRequest(
        name: String,
        region: String,
        projectID: String,
        token: String,
        body: Data
    ) async throws -> CallableResult {
        guard let url = URL(string: "https://\(region)-\(projectID).cloudfunctions.net/\(name)") else {
            throw CallableError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.httpBody = body

        let (responseData, response) = try await session.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw CallableError.decodingError
        }

        guard (200...299).contains(httpResponse.statusCode) else {
            let bodyStr = String(data: responseData, encoding: .utf8) ?? ""
            let envelope = ((try? JSONSerialization.jsonObject(with: responseData)) as? [String: Any])?["error"] as? [String: Any]
            throw CallableError.httpError(
                statusCode: httpResponse.statusCode,
                status: envelope?["status"] as? String,
                message: envelope?["message"] as? String,
                body: bodyStr
            )
        }

        guard let json = try JSONSerialization.jsonObject(with: responseData) as? [String: Any] else {
            throw CallableError.decodingError
        }

        let resultData = json["result"] ?? json
        return CallableResult(data: resultData)
    }

    private nonisolated static func currentAuthToken() async throws -> String {
        guard let user = Auth.auth().currentUser else {
            throw CallableError.noAuthToken
        }
        return try await user.getIDToken()
    }
}
