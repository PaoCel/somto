import Foundation

// Il widget NON parla con Firebase, e non e' una scorciatoia: e' l'unica cosa
// che funziona.
//
//  * `FirebaseBootstrap.configureIfNeeded()` cerca la config con `Bundle.main`,
//    che dentro un'estensione e' il `.appex` e non l'app: `fatalError`.
//  * Il keychain non e' condiviso fra app ed estensione, quindi `Auth.currentUser`
//    qui non esiste comunque.
//  * `FirebaseFirestore` si porta dietro gRPC/BoringSSL, cioe' la dipendenza che
//    da sola domina il budget di memoria di un widget.
//
// Le prossime uscite sono un dato globale e pubblico: niente di tutto questo
// serve. Si legge un JSON con `URLSession`, servito dalla Cloud Function
// `upcomingReleasesFeed` (functions/modules/upcomingReleasesFeed.js).

// MARK: - Modello

/// Una uscita in arrivo, nella forma in cui la serve il feed.
///
/// Il payload arriva gia' normalizzato dal server (URL del poster ridotto,
/// percorso del deep link, data ISO): qui non si interpreta niente, si decodifica.
struct UpcomingRelease: Decodable, Sendable {
    let id: String
    let name: String
    let type: String
    let releaseDate: Date
    let posterUrl: URL?
    let url: URL?
    /// Dove esce: `cinema`, `streaming`, `tv`. Assente quando il server non lo
    /// sa — cioe' quando TMDB non ha una data italiana con un tipo dichiarato.
    let releaseKind: String?
    /// Cosa esce: `release` (un film) o `season_premiere` (una serie che torna).
    let occasion: String?
    /// Il numero della stagione che comincia, quando `occasion` e' una premiere.
    let season: Int?
    /// La piattaforma su cui si vede. Ce l'hanno le serie che tornano, non i
    /// film che devono uscire: TMDB pubblica i provider alla disponibilita'.
    let provider: UpcomingReleaseProvider?

    var isSeries: Bool { type == "tv" }
    var kind: UpcomingReleaseKind? { UpcomingReleaseKind(rawValue: releaseKind ?? "") }
    /// Un valore sconosciuto vale `release`: mostrare la riga come un'uscita
    /// normale e' sempre giusto, e non mostrarla per niente no.
    var occasionKind: UpcomingReleaseOccasion {
        UpcomingReleaseOccasion(rawValue: occasion ?? "") ?? .release
    }
}

/// La piattaforma su cui si vede: nome (per VoiceOver e per il ripiego
/// testuale) e logo gia' ridotto dal server.
struct UpcomingReleaseProvider: Decodable, Sendable {
    let name: String
    let logoUrl: URL?
}

/// Cosa esce.
enum UpcomingReleaseOccasion: String, Sendable {
    case release
    case seasonPremiere = "season_premiere"
}

/// Il canale d'uscita, nella forma che il widget disegna.
///
/// L'inizializzatore da stringa scarta i valori che non conosce invece di
/// fallire: il feed puo' aggiungere un canale nuovo (`cinema_evento`, un giorno)
/// e i widget gia' installati devono limitarsi a non mostrarlo, non a rompersi.
enum UpcomingReleaseKind: String, Sendable {
    case cinema
    case streaming
    case tv
}

/// La busta del feed. `version` esiste per poter cambiare la forma del payload
/// senza rompere i widget gia' installati: un widget che non riconosce la
/// versione mostra lo stato di errore invece di disegnare campi a caso.
struct UpcomingReleasesFeed: Decodable, Sendable {
    let version: Int
    let items: [UpcomingRelease]
}

enum UpcomingReleasesFeedError: Error {
    case invalidEndpoint
    case badResponse(status: Int)
    case unsupportedVersion(Int)
}

// MARK: - Caricamento

enum UpcomingReleasesFeedLoader {
    static let endpoint = "https://somto.it/prossime-uscite.json"
    static let supportedVersion = 1

    /// Oltre questa soglia il poster non e' un poster: si rinuncia invece di
    /// infilare megabyte in una timeline che il sistema deve archiviare.
    private static let maxPosterBytes = 400_000
    private static let requestTimeout: TimeInterval = 15
    private static let cacheFileName = "upcoming-releases.json"

    /// Le uscite in arrivo. In caso di errore di rete ricade sull'ultima
    /// risposta valida salvata su disco: un widget che perde la rete per un
    /// minuto non deve svuotarsi.
    static func loadReleases() async throws -> [UpcomingRelease] {
        do {
            let data = try await fetchFeedData()
            let releases = try decodeReleases(from: data)
            writeCache(data)
            return releases
        } catch {
            guard let cached = readCache(), let releases = try? decodeReleases(from: cached) else {
                throw error
            }
            return releases
        }
    }

    /// I byte di un'immagine (locandina o logo). Viaggiano dentro la timeline
    /// perche' la View di un widget non puo' fare rete: quando si disegna, o
    /// l'immagine c'e' gia', o non ci sara' mai.
    static func loadImageData(for url: URL) async -> Data? {
        do {
            let request = URLRequest(url: url, timeoutInterval: requestTimeout)
            let (data, response) = try await URLSession.shared.data(for: request)
            guard
                let http = response as? HTTPURLResponse,
                (200..<300).contains(http.statusCode),
                data.count <= maxPosterBytes,
                !data.isEmpty
            else {
                return nil
            }
            return data
        } catch {
            // Un'immagine mancante e' una riga senza copertina, non un widget
            // rotto: lo stato di errore e' riservato al feed.
            return nil
        }
    }

    // MARK: - Rete

    private static func fetchFeedData() async throws -> Data {
        guard let url = URL(string: endpoint) else {
            throw UpcomingReleasesFeedError.invalidEndpoint
        }
        let request = URLRequest(url: url, timeoutInterval: requestTimeout)
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw UpcomingReleasesFeedError.badResponse(status: -1)
        }
        guard (200..<300).contains(http.statusCode) else {
            throw UpcomingReleasesFeedError.badResponse(status: http.statusCode)
        }
        return data
    }

    private static func decodeReleases(from data: Data) throws -> [UpcomingRelease] {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let raw = try decoder.singleValueContainer().decode(String.self)
            guard let date = iso8601Date(from: raw) else {
                throw DecodingError.dataCorrupted(
                    DecodingError.Context(codingPath: decoder.codingPath, debugDescription: "data non ISO 8601")
                )
            }
            return date
        }

        let feed = try decoder.decode(UpcomingReleasesFeed.self, from: data)
        guard feed.version == supportedVersion else {
            throw UpcomingReleasesFeedError.unsupportedVersion(feed.version)
        }
        return feed.items
    }

    /// Il server emette `toISOString()`, quindi sempre con i millisecondi. Il
    /// fallback senza frazione c'e' perche' un contratto si legge largo e si
    /// scrive stretto, non perche' oggi serva.
    private static func iso8601Date(from raw: String) -> Date? {
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = withFraction.date(from: raw) { return date }

        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: raw)
    }

    // MARK: - Cache su disco

    // La cache vive nel container dell'ESTENSIONE, non in un App Group: qui non
    // si condivide niente con l'app, si sopravvive a una richiesta fallita.
    // Niente entitlement da aggiungere, niente dato dell'utente sul disco.
    private static var cacheURL: URL? {
        FileManager.default
            .urls(for: .cachesDirectory, in: .userDomainMask)
            .first?
            .appendingPathComponent(cacheFileName)
    }

    private static func readCache() -> Data? {
        guard let cacheURL else { return nil }
        return try? Data(contentsOf: cacheURL)
    }

    private static func writeCache(_ data: Data) {
        guard let cacheURL else { return }
        // Se la scrittura fallisce si perde solo la rete di sicurezza del giro
        // successivo: non c'e' niente da dire all'utente, e niente da fermare.
        try? data.write(to: cacheURL, options: .atomic)
    }
}
