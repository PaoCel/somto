import Foundation

// Come fa un widget a scrivere per conto dell'utente.
//
// IL PROBLEMA — un bottone in un widget e' un App Intent, e gira nel processo
// dell'ESTENSIONE. Li' non c'e' sessione: il keychain non e' condiviso, quindi
// `Auth.currentUser` non esiste, e portarsi dentro `FirebaseAuth` +
// `FirebaseFirestore` significherebbe gRPC/BoringSSL nel processo con meno
// memoria di tutti.
//
// COSA SI E' SCOPERTO GUARDANDO IL CODICE — "episodio visto" non e' una scrittura
// diretta su Firestore: `WatchlistRepository.markSeriesEpisodeWatched` chiama la
// callable `applyTitleStateAction`, e `CloudFunctionsCaller` la invoca con un
// normale POST HTTPS piu' `Authorization: Bearer <idToken>`. Quindi
// all'estensione non serve nessun SDK: serve un token.
//
// LA SOLUZIONE — l'app deposita in un keychain access group condiviso il
// refresh token dell'utente (piu' i pochi dati di progetto che servono a usarlo)
// e l'estensione se lo scambia per un id token fresco su
// `securetoken.googleapis.com`, poi chiama la callable.
//
// PERCHE' UN ITEM NOSTRO E NON `Auth.auth().userAccessGroup` — quella e' la
// strada ufficiale di Firebase, ma SPOSTA dove vive la sessione di un'app gia'
// sullo Store: se la migrazione va storta, la coorte si ritrova sloggata. Qui
// invece non si tocca niente di Firebase: si scrive un item nuovo, e nel caso
// peggiore il bottone del widget non funziona.
//
// COSA COMPORTA, DETTO CHIARO — un credenziale a lunga vita in piu' sul
// dispositivo. Mitigazioni: `ThisDeviceOnly` (non finisce in nessun backup ne'
// su iCloud), cancellato al logout e a ogni cambio utente (vedi `clear()`), e
// resta comunque dentro il keychain, cioe' la stessa cassaforte dove Firebase
// tiene gia' la sessione.

// MARK: - Cosa serve all'estensione

/// Il minimo per chiamare una callable per conto dell'utente.
///
/// `apiKey` e `projectID` non sono segreti — viaggiano nel binario di ogni app
/// pubblicata e in ogni richiesta — ma stanno qui lo stesso: cosi' l'estensione
/// non ha bisogno di imbustarsi i plist di configurazione.
struct WidgetAuthCredentials: Codable, Sendable, Hashable {
    let uid: String
    let refreshToken: String
    let apiKey: String
    let projectID: String
    let functionsRegion: String
    /// L'ultimo id token ottenuto, con la sua scadenza.
    ///
    /// PERCHE' SI TIENE — senza cache ogni tap sul bottone del widget sono DUE
    /// richieste: lo scambio del refresh token e poi la callable. E' quella in
    /// piu' che si sentiva sotto le dita (feedback dal device, 2026-08-14: "mi
    /// ha fatto aspettare, uno farebbe doppio tap"). Un id token dura un'ora:
    /// tenerlo significa che il secondo tap paga una richiesta sola.
    var cachedIdToken: String?
    var cachedIdTokenExpiry: Date?

    init(
        uid: String,
        refreshToken: String,
        apiKey: String,
        projectID: String,
        functionsRegion: String,
        cachedIdToken: String? = nil,
        cachedIdTokenExpiry: Date? = nil
    ) {
        self.uid = uid
        self.refreshToken = refreshToken
        self.apiKey = apiKey
        self.projectID = projectID
        self.functionsRegion = functionsRegion
        self.cachedIdToken = cachedIdToken
        self.cachedIdTokenExpiry = cachedIdTokenExpiry
    }
}

// MARK: - Keychain condiviso

enum WidgetAuthStore {
    /// L'access group condiviso fra app ed estensione. Il prefisso lo mette il
    /// sistema (`$(AppIdentifierPrefix)` negli entitlement), qui va il resto.
    static let accessGroup = "787YK9YUB3.com.paolocelestini.twowatch.shared"

    private static let service = "it.somto.widget.auth"
    private static let account = "current-user"

    static func save(_ credentials: WidgetAuthCredentials) {
        guard let data = try? JSONEncoder().encode(credentials) else { return }
        // Si cancella e si riscrive invece di aggiornare: e' un item solo, e
        // `SecItemUpdate` avrebbe un ramo in piu' da sbagliare.
        clear()
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessGroup as String: accessGroup,
            // Il widget si aggiorna anche a schermo bloccato, ma solo dopo il
            // primo sblocco dall'avvio: `AfterFirstUnlock` e' il minimo che
            // funziona. `ThisDeviceOnly` tiene il token fuori dai backup.
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            kSecValueData as String: data,
        ]
        SecItemAdd(query as CFDictionary, nil)
    }

    static func load() -> WidgetAuthCredentials? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessGroup as String: accessGroup,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data
        else {
            return nil
        }
        return try? JSONDecoder().decode(WidgetAuthCredentials.self, from: data)
    }

    static func clear() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessGroup as String: accessGroup,
        ]
        SecItemDelete(query as CFDictionary)
    }

    /// Butta il token se questa e' la prima apertura dopo un'installazione
    /// pulita.
    ///
    /// PERCHE' SERVE — il keychain **sopravvive alla disinstallazione**
    /// dell'app, `UserDefaults` no. Senza questo controllo, chi installa Somto
    /// su un telefono di seconda mano (o dopo aver disinstallato) troverebbe nel
    /// keychain il refresh token di prima: valido, e di un altro account.
    static func clearIfFreshInstall(defaults: UserDefaults = .standard) {
        let marker = "somto.widgetAuth.installMarker"
        guard !defaults.bool(forKey: marker) else { return }
        clear()
        defaults.set(true, forKey: marker)
    }
}

// MARK: - Dal refresh token all'id token

enum WidgetAuthError: Error {
    case notSignedIn
    case tokenExchangeFailed(status: Int)
    case malformedResponse
}

enum WidgetTokenExchange {
    /// Un id token fresco.
    ///
    /// E' l'endpoint pubblico di Firebase Auth (`securetoken`), lo stesso che
    /// l'SDK usa sotto il cofano. Se Google ruota il refresh token, la versione
    /// nuova torna nella risposta e si risalva: senza, al giro dopo si
    /// resterebbe con uno scaduto.
    static func idToken(session: URLSession = .shared, now: Date = Date()) async throws -> String {
        guard let credentials = WidgetAuthStore.load() else { throw WidgetAuthError.notSignedIn }

        // Due minuti di margine: un token che scade mentre la richiesta e' in
        // volo tornerebbe 401, e il bottone sembrerebbe rotto.
        if let cached = credentials.cachedIdToken,
           let expiry = credentials.cachedIdTokenExpiry,
           expiry.timeIntervalSince(now) > 120 {
            return cached
        }

        guard let url = URL(string: "https://securetoken.googleapis.com/v1/token?key=\(credentials.apiKey)") else {
            throw WidgetAuthError.malformedResponse
        }

        var request = URLRequest(url: url, timeoutInterval: 20)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        let refresh = credentials.refreshToken.addingPercentEncoding(
            withAllowedCharacters: .alphanumerics
        ) ?? credentials.refreshToken
        request.httpBody = Data("grant_type=refresh_token&refresh_token=\(refresh)".utf8)

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw WidgetAuthError.malformedResponse }
        guard (200..<300).contains(http.statusCode) else {
            // 400 = refresh token revocato o non piu' valido (cambio password,
            // account cancellato): l'item non serve piu' a niente e resterebbe
            // li' a fare da credenziale morta.
            if http.statusCode == 400 { WidgetAuthStore.clear() }
            throw WidgetAuthError.tokenExchangeFailed(status: http.statusCode)
        }

        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let idToken = json["id_token"] as? String, !idToken.isEmpty
        else {
            throw WidgetAuthError.malformedResponse
        }

        // Si risalva sempre, non solo quando il refresh token ruota: e' il giro
        // in cui si mette in cache l'id token appena ottenuto.
        let lifetime = TimeInterval(Int(json["expires_in"] as? String ?? "") ?? 3600)
        let rotated = (json["refresh_token"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        WidgetAuthStore.save(WidgetAuthCredentials(
            uid: credentials.uid,
            refreshToken: rotated ?? credentials.refreshToken,
            apiKey: credentials.apiKey,
            projectID: credentials.projectID,
            functionsRegion: credentials.functionsRegion,
            cachedIdToken: idToken,
            cachedIdTokenExpiry: now.addingTimeInterval(lifetime)
        ))

        return idToken
    }
}

// MARK: - Chiamare una callable dall'estensione

enum WidgetCallableError: Error {
    case invalidURL
    case http(status: Int, body: String)
}

/// Il minimo per invocare una callable via HTTPS.
///
/// Non riusa `CloudFunctionsCaller` di proposito: quello e' `@MainActor`, tira
/// dentro `FirebaseAuth` per il token, `FirebaseConfig` per il progetto e
/// `UserFacingError` per i messaggi — tre dipendenze che nell'estensione non
/// esistono e non devono esistere. Il protocollo callable, invece, e' due righe:
/// POST `{"data": …}`, risposta `{"result": …}`.
enum WidgetCallableClient {
    /// - Returns: il contenuto di `result`, che per `applyTitleStateAction` e'
    ///   `{ ok, state }` — cioe' lo stato aggiornato del titolo. Serve al widget
    ///   per mostrare il punto NUOVO invece di una conferma generica.
    @discardableResult
    static func call(
        name: String,
        data payload: [String: Any],
        session: URLSession = .shared
    ) async throws -> [String: Any] {
        guard let credentials = WidgetAuthStore.load() else { throw WidgetAuthError.notSignedIn }
        let token = try await WidgetTokenExchange.idToken(session: session)
        guard let url = URL(string: "https://\(credentials.functionsRegion)-\(credentials.projectID).cloudfunctions.net/\(name)") else {
            throw WidgetCallableError.invalidURL
        }

        var request = URLRequest(url: url, timeoutInterval: 30)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["data": payload])

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw WidgetAuthError.malformedResponse }
        guard (200..<300).contains(http.statusCode) else {
            throw WidgetCallableError.http(
                status: http.statusCode,
                body: String(data: data, encoding: .utf8) ?? ""
            )
        }

        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        return (json?["result"] as? [String: Any]) ?? [:]
    }
}
