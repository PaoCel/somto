@preconcurrency import FirebaseFirestore
@preconcurrency import FirebaseFunctions
@preconcurrency import FirebaseStorage
import Foundation

struct TitlesImportOptions: Hashable {
    var countExistingAsRewatch = false
    // Consenso opt-in (solo TV Time) alla ripubblicazione dei propri commenti-
    // episodio come discussioni Somto. Default ON: i commenti finiscono in una
    // coda di revisione lato server (importCommentReview); NIENTE viene
    // pubblicato automaticamente — la pubblicazione resta un passo admin dopo
    // revisione umana. Ininfluente per Netflix/Refract (nessun commento).
    var importComments = true

    var payload: [String: Any] {
        [
            "countDuplicateRewatches": true,
            "countExistingAsRewatch": countExistingAsRewatch,
            "importComments": importComments
        ]
    }
}

struct TitlesImportJob: Identifiable, Hashable {
    let id: String
    let status: String
    let totalRows: Int
    let processedCount: Int
    let matchedCount: Int
    let unresolvedCount: Int
    let errorCount: Int
    let error: String?
    // Only known once the Firestore listener delivers the job doc (the
    // `startTitlesImport` callable response itself doesn't echo it back) —
    // nil right after starting, populated a moment later by observeImport.
    // Used to gate source-specific copy (e.g. the ratings-conversion note,
    // which must never show for tvtime_refract — that format carries no
    // votes/reviews at all).
    let source: String?
    // Popolati dal server sia al primo finalize (0 di default) sia da
    // `confirmTitlesImport` (conteggio esatto via aggregazione): quanti
    // titoli sono stati effettivamente scritti in libreria / quante righe
    // sono state saltate. Usati dallo Screen C (riepilogo completato).
    let importedTitleCount: Int
    let skippedCount: Int

    var progressFraction: Double {
        guard totalRows > 0 else { return status == "queued" ? 0.05 : 0.1 }
        return min(1, max(0.05, Double(processedCount) / Double(totalRows)))
    }

    var isTerminal: Bool {
        status == "completed" || status == "awaiting_confirmation" || status == "failed" || status == "manual_processing"
    }
}

/// Suggerimento del matcher per una riga NON risolta automaticamente
/// (confidence sotto la soglia auto-import ma sopra la soglia minima per
/// mostrarlo). Il server valida comunque `confidence>=0.6` quando il client
/// invia `acceptSuggestion:true` — vedi `confirmTitlesImport`.
struct TitlesImportSuggestion: Hashable {
    let tmdbId: Int
    let name: String
    let year: Int?
    let posterPath: String?
    let mediaType: String?

    var displayLabel: String {
        let kind: String
        switch mediaType {
        case "movie": kind = "Film"
        case "tv": kind = "Serie"
        default: kind = ""
        }
        return [name, year.map(String.init), kind]
            .compactMap { value in
                guard let value, !value.isEmpty else { return nil }
                return value
            }
            .joined(separator: " · ")
    }
}

/// Riga `users/{uid}/imports/{importId}/items/{itemId}` NON ancora risolta
/// (`resolved==false && skip==false`), da mostrare nello Screen B (review
/// manuale). Sola lettura: le decisioni si inviano a `confirmTitlesImport`
/// via `TitlesImportResolution`, mai scrivendo direttamente il doc.
struct TitlesImportUnresolvedItem: Identifiable, Hashable {
    let itemId: String
    let rawTitle: String?
    let kind: String?
    let refKind: String?
    let seriesNameGuess: String?
    let movieNameGuess: String?
    let seasonNumber: Int?
    let episodeNumber: Int?
    let episodeNameGuess: String?
    let confidence: Double?
    let strategy: String?
    let suggestion: TitlesImportSuggestion?

    var id: String { itemId }

    /// Etichetta leggibile per la riga: nome film/serie indovinato + stagione
    /// ed episodio quando presenti, altrimenti il testo grezzo della riga.
    var displayLabel: String {
        if let movieNameGuess, !movieNameGuess.isEmpty {
            return movieNameGuess
        }
        if let seriesNameGuess, !seriesNameGuess.isEmpty {
            if let seasonNumber, let episodeNumber {
                return "\(seriesNameGuess) · S\(seasonNumber)E\(episodeNumber)"
            }
            return seriesNameGuess
        }
        return rawTitle ?? "Titolo sconosciuto"
    }

    /// Etichetta del tipo riga (film/episodio), per il sottotitolo della riga.
    var kindLabel: String {
        switch refKind {
        case "movie": return "Film"
        case "tv": return "Episodio"
        default: return "Titolo"
        }
    }
}

/// Azione di risoluzione per una riga inviata a `confirmTitlesImport`.
/// Rispecchia le 3 forme accettate dal server (contratto già deployato,
/// vedi `functions/lib/importAdapters/confirmPlan.js`).
enum TitlesImportResolutionAction: Hashable {
    /// Importa esplicitamente un titolo scelto dall'utente (ricerca manuale).
    case importTitle(titleId: String)
    /// Ignora la riga (non verrà più mostrata come da controllare).
    case skip
    /// Accetta il miglior suggerimento del matcher (il server valida
    /// comunque `confidence>=0.6` + presenza di `suggestion.tmdbId`).
    case acceptSuggestion
}

struct TitlesImportResolution: Hashable {
    let itemId: String
    let action: TitlesImportResolutionAction

    var payload: [String: Any] {
        switch action {
        case .importTitle(let titleId):
            return ["itemId": itemId, "titleId": titleId]
        case .skip:
            return ["itemId": itemId, "skip": true]
        case .acceptSuggestion:
            return ["itemId": itemId, "acceptSuggestion": true]
        }
    }
}

/// Risposta di `confirmTitlesImport`. Idempotente: una seconda chiamata su un
/// import già `completed` ritorna `alreadyCompleted:true` senza rifare nulla.
struct TitlesImportConfirmResult: Hashable {
    let ok: Bool
    let importId: String
    let status: String
    let resolvedCount: Int
    let importedTitleCount: Int
    let skippedCount: Int
    let unresolvedCount: Int
    let alreadyCompleted: Bool
}

/// Sessione di upload diretto app -> Storage, usata da tvtime_refract (sempre)
/// e da tvtime_gdpr/netflix_csv quando il payload è troppo grande per il body
/// della callable (doc Firestore 1MB): `createTitlesImportUploadSession` crea
/// il job doc + riserva i path Storage, il client carica i file via SDK, poi
/// `finalizeTitlesImportUpload` scarica da Storage e ACCODA il matching
/// resumabile (`status: "queued"`). Stesso contratto server del path web.
struct RefractUploadSession {
    let importId: String
    /// chiave kind (movies/series/netflix/...) -> path Storage (solo le
    /// chiavi effettivamente richieste dalla sessione).
    let storagePaths: [String: String]
}

/// Risposta di `startTraktConnect`: codice utente da mostrare + URL da aprire
/// su trakt.tv/activate (OAuth device flow, RFC 8628). `interval` è il periodo
/// di poll consigliato dal server (secondi), `expiresIn` la validità del
/// device code (secondi) oltre la quale il flusso va riavviato.
struct TraktConnectSession: Hashable {
    let userCode: String
    let verificationUrl: String
    let interval: Int
    let expiresIn: Int
}

/// Stato del poll `pollTraktConnect`. Il client ripete il poll ogni
/// `interval` secondi finché non arriva "connected" (o un esito terminale).
enum TraktConnectStatus: String {
    case pending
    case connected
    case expired
    case denied
    case none
}

@MainActor
final class TitlesImportRepository {
    private let db = Firestore.firestore()
    private let functions = Functions.functions(region: "europe-west1")

    /// Invoca una Cloud Function callable via l'API a completion-handler avvolta in
    /// una `withCheckedThrowingContinuation`, NON la `call(_:) async` del Firebase
    /// SDK: quest'ultima ha un crash di runtime (`async let` fatalError in
    /// `HTTPSCallable.SendableHTTPSCallable.call`, vedi `CloudFunctionsCaller`) che
    /// si manifesta ad es. su `createTitlesImportUploadSession`. Qui restiamo sul
    /// SDK (risolve region/gen1-gen2) ma via callback. Ritorna `result.data`.
    private func callImportFunction(_ name: String, payload: [String: Any], timeout: TimeInterval? = nil) async throws -> Any {
        // Passa da CloudFunctionsCaller (POST HTTP diretto) come il resto dell'app,
        // NON dal Firebase SDK: la sua `HTTPSCallable.call(_:) async` ha un crash di
        // runtime (`async let` fatalError in `SendableHTTPSCallable.call`) che si
        // manifesta sull'upload import (createTitlesImportUploadSession). Le call
        // sono leggere (create/finalize accodano e ritornano subito; il matching
        // pesante gira async lato server), quindi il timeout del session è ampio —
        // il `timeout` richiesto qui resta solo indicativo.
        _ = timeout
        let result = try await CloudFunctionsCaller.call(name: name, data: payload)
        return result.data
    }

    func startNetflixImport(rawCsv: String, options: TitlesImportOptions) async throws -> TitlesImportJob {
        // Parse+enqueue lato server: sui payload inline vicini alla soglia
        // (700KB) il default di 70s può non bastare — allineato ai 120s delle
        // altre callable di import.
        let data = try await callImportFunction("startTitlesImport", payload: [
            "source": "netflix_csv",
            "platform": "ios",
            "rawCsv": rawCsv,
            "dryRun": false,
            "options": options.payload
        ], timeout: 120)
        return try Self.parseStartResponse(data)
    }

    /// TV Time GDPR export: l'app ora estrae lo ZIP intero in-app (`TVTimeZip`,
    /// port della web `tvTimeZip.js`: legge la central directory + inflate del raw
    /// DEFLATE via `Compression`), quindi l'utente carica direttamente lo ZIP e i 2
    /// CSV (`tracking-prod-records.csv` / `-v2.csv`) vengono estratti da soli; i
    /// picker dei file singoli restano come fallback (vedi TitlesImportView).
    /// Stesso contratto server del path web.
    func startTvTimeImport(rawCsvV1: String, rawCsvV2: String, options: TitlesImportOptions) async throws -> TitlesImportJob {
        // Stesso timeout esteso di startNetflixImport (parse di 2 CSV inline).
        let data = try await callImportFunction("startTitlesImport", payload: [
            "source": "tvtime_gdpr",
            "platform": "ios",
            "rawCsvV1": rawCsvV1,
            "rawCsvV2": rawCsvV2,
            "dryRun": false,
            "options": options.payload
        ], timeout: 120)
        return try Self.parseStartResponse(data)
    }

    /// Avvia l'OAuth device flow di Trakt: il server crea il device code e lo
    /// registra su `usersPrivate/{uid}/integrations/trakt` (status "pending").
    /// Ritorna il codice da far inserire su trakt.tv/activate + l'URL da aprire.
    func startTraktConnect() async throws -> TraktConnectSession {
        let response = try await callImportFunction("startTraktConnect", payload: [:])
        guard let data = response as? [String: Any],
              let userCode = FirestoreValueReader.string(data, key: "userCode"),
              let verificationUrl = FirestoreValueReader.string(data, key: "verificationUrl"),
              let interval = FirestoreValueReader.int(data, key: "interval"),
              let expiresIn = FirestoreValueReader.int(data, key: "expiresIn")
        else {
            throw TitlesImportError.invalidResponse
        }
        return TraktConnectSession(userCode: userCode, verificationUrl: verificationUrl, interval: interval, expiresIn: expiresIn)
    }

    /// Interroga lo stato del device flow avviato da `startTraktConnect`. Va
    /// chiamata ogni `interval` secondi finché non torna `.connected` (o un
    /// esito terminale: `.expired`/`.denied`/`.none`). Il server non ritorna
    /// mai il token di accesso qui: resta lato server.
    func pollTraktConnect() async throws -> TraktConnectStatus {
        let response = try await callImportFunction("pollTraktConnect", payload: [:])
        guard let data = response as? [String: Any],
              let raw = FirestoreValueReader.string(data, key: "status"),
              let status = TraktConnectStatus(rawValue: raw)
        else {
            throw TitlesImportError.invalidResponse
        }
        return status
    }

    /// Avvia l'import da Trakt (account già collegato via device flow). Il
    /// server legge il token salvato, scarica watched/ratings/watchlist da
    /// Trakt e accoda il matching resumabile — stesso ciclo di vita
    /// (`users/{uid}/imports/{importId}`) delle altre sorgenti.
    func startTraktImport(options: TitlesImportOptions) async throws -> TitlesImportJob {
        let data = try await callImportFunction("startTraktImport", payload: [
            "dryRun": false,
            "platform": "ios",
            "options": options.payload
        ], timeout: 120)
        return try Self.parseStartResponse(data)
    }

    /// Apre una sessione di upload diretto a Storage per QUALSIASI sorgente
    /// (tvtime_refract sempre; tvtime_gdpr/netflix_csv quando il payload è
    /// troppo grande per il body della callable — doc Firestore 1MB).
    /// `fileFlags` = mappa `has*` -> Bool (hasMovies/hasSeries/hasNetflix/
    /// hasEpisodeVotes/...) che dice al server quali file aspettarsi; il server
    /// whitelista i filename per sorgente.
    func createImportUploadSession(source: String, fileFlags: [String: Bool], options: TitlesImportOptions) async throws -> RefractUploadSession {
        var payload: [String: Any] = ["source": source, "platform": "ios", "options": options.payload]
        for (key, value) in fileFlags { payload[key] = value }
        let response = try await callImportFunction("createTitlesImportUploadSession", payload: payload)
        guard let data = response as? [String: Any],
              let importId = FirestoreValueReader.string(data, key: "importId"),
              let storagePaths = data["storagePaths"] as? [String: String]
        else {
            throw TitlesImportError.invalidResponse
        }
        return RefractUploadSession(importId: importId, storagePaths: storagePaths)
    }

    /// Upload generico dei file di una sessione (CSV o JSON). `texts` è una
    /// mappa kind->contenuto; il content-type è dedotto dall'estensione del
    /// path (.json vs .csv) e DEVE combaciare con storage.rules
    /// (isJsonUpload/isCsvUpload).
    func uploadImportFiles(storagePaths: [String: String], texts: [String: String]) async throws {
        for (kind, path) in storagePaths {
            guard let text = texts[kind], !text.isEmpty else { continue }
            guard let data = text.data(using: .utf8) else {
                throw TitlesImportError.unreadableFile
            }
            let metadata = StorageMetadata()
            metadata.contentType = path.hasSuffix(".json") ? "application/json;charset=utf-8" : "text/csv;charset=utf-8"
            let ref = Storage.storage().reference(withPath: path)
            _ = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<StorageMetadata, Error>) in
                ref.putData(data, metadata: metadata) { returned, error in
                    if let error {
                        continuation.resume(throwing: error)
                    } else if let returned {
                        continuation.resume(returning: returned)
                    } else {
                        continuation.resume(throwing: NSError(
                            domain: "TwoWatch.TitlesImportRepository",
                            code: -1,
                            userInfo: [NSLocalizedDescriptionKey: "Upload file fallito."]
                        ))
                    }
                }
            }
        }
    }

    /// STEP 3: il server scarica i file da Storage, fa il parse (cheap) e
    /// ACCODA il matching resumabile (worker a tick), ritornando subito
    /// `{status:"queued"}`. Il matching + scrittura girano in background: il
    /// chiamante segue lo stato finale dal listener Firestore (observeImport),
    /// esattamente come per il body callable. Timeout basso: qui il server fa
    /// solo download+parse, non più l'intero matching.
    func finalizeImportUpload(importId: String) async throws -> TitlesImportJob {
        let data = try await callImportFunction("finalizeTitlesImportUpload", payload: ["importId": importId], timeout: 120)
        return try Self.parseStartResponse(data)
    }

    private static func parseStartResponse(_ raw: Any?) throws -> TitlesImportJob {
        guard let data = raw as? [String: Any],
              let importId = FirestoreValueReader.string(data, key: "importId")
        else {
            throw TitlesImportError.invalidResponse
        }

        return TitlesImportJob(
            id: importId,
            status: FirestoreValueReader.string(data, key: "status") ?? "queued",
            totalRows: FirestoreValueReader.int(data, key: "totalRows") ?? 0,
            processedCount: 0,
            matchedCount: FirestoreValueReader.int(data, key: "matchedCount") ?? 0,
            unresolvedCount: FirestoreValueReader.int(data, key: "unresolvedCount") ?? 0,
            errorCount: FirestoreValueReader.int(data, key: "errorCount") ?? 0,
            error: nil,
            source: FirestoreValueReader.string(data, key: "source"),
            importedTitleCount: FirestoreValueReader.int(data, key: "importedTitleCount") ?? 0,
            skippedCount: FirestoreValueReader.int(data, key: "skippedCount") ?? 0
        )
    }

    func observeImport(userID: String, importID: String, onChange: @escaping (TitlesImportJob?) -> Void) -> ListenerRegistration {
        db.collection("users")
            .document(userID)
            .collection("imports")
            .document(importID)
            .addSnapshotListener { snapshot, _ in
                guard let snapshot, snapshot.exists else {
                    Task { @MainActor in onChange(nil) }
                    return
                }
                let data = snapshot.data() ?? [:]
                let job = TitlesImportJob(
                    id: snapshot.documentID,
                    status: FirestoreValueReader.string(data, key: "status") ?? "queued",
                    totalRows: FirestoreValueReader.int(data, key: "totalRows") ?? 0,
                    processedCount: FirestoreValueReader.int(data, key: "processedCount") ?? 0,
                    matchedCount: FirestoreValueReader.int(data, key: "matchedCount") ?? 0,
                    unresolvedCount: FirestoreValueReader.int(data, key: "unresolvedCount") ?? 0,
                    errorCount: FirestoreValueReader.int(data, key: "errorCount") ?? 0,
                    error: FirestoreValueReader.string(data, key: "error"),
                    source: FirestoreValueReader.string(data, key: "source"),
                    importedTitleCount: FirestoreValueReader.int(data, key: "importedTitleCount") ?? 0,
                    skippedCount: FirestoreValueReader.int(data, key: "skippedCount") ?? 0
                )
                Task { @MainActor in onChange(job) }
            }
    }

    /// L'import NON terminale piu' recente dell'utente (in corso o pronto da
    /// confermare), o nil. Serve a RIPRENDERE lo stato quando si riapre la
    /// schermata import invece di mostrare un picker vuoto — un picker vuoto fa
    /// credere che il caricamento precedente non sia riuscito e spinge a
    /// ricaricare lo stesso file (causa n.1 del carico Firestore). Gli stati di
    /// elaborazione stantii (>24h, sessione abbandonata) sono ignorati;
    /// awaiting_confirmation resta sempre valido (lavoro reale da confermare).
    func fetchActiveImport(userID: String) async throws -> TitlesImportJob? {
        let snapshot = try await db.collection("users")
            .document(userID)
            .collection("imports")
            .whereField("status", in: ["queued", "matching", "uploading", "awaiting_confirmation"])
            .limit(to: 10)
            .getDocuments()
        let now = Date()
        var best: TitlesImportJob?
        var bestMs: TimeInterval = -1
        for doc in snapshot.documents {
            let data = doc.data()
            let status = FirestoreValueReader.string(data, key: "status") ?? "queued"
            let updated = (data["updatedAt"] as? Timestamp)?.dateValue()
            let fresh = status == "awaiting_confirmation"
                || updated == nil
                || now.timeIntervalSince(updated!) < 24 * 60 * 60
            if !fresh { continue }
            let ms = updated?.timeIntervalSince1970 ?? 0
            if ms > bestMs {
                bestMs = ms
                best = TitlesImportJob(
                    id: doc.documentID,
                    status: status,
                    totalRows: FirestoreValueReader.int(data, key: "totalRows") ?? 0,
                    processedCount: FirestoreValueReader.int(data, key: "processedCount") ?? 0,
                    matchedCount: FirestoreValueReader.int(data, key: "matchedCount") ?? 0,
                    unresolvedCount: FirestoreValueReader.int(data, key: "unresolvedCount") ?? 0,
                    errorCount: FirestoreValueReader.int(data, key: "errorCount") ?? 0,
                    error: FirestoreValueReader.string(data, key: "error"),
                    source: FirestoreValueReader.string(data, key: "source"),
                    importedTitleCount: FirestoreValueReader.int(data, key: "importedTitleCount") ?? 0,
                    skippedCount: FirestoreValueReader.int(data, key: "skippedCount") ?? 0
                )
            }
        }
        return best
    }

    /// Ultimo import COMPLETATO, per il reveal in Home ("la tua libreria è
    /// pronta", docs/ONBOARDING_V2.md fase 6). Specchio di
    /// `getLastCompletedImport` sul web: nessun `orderBy`, la collection è
    /// piccola per utente e ordinarla lato server chiederebbe un indice in più
    /// per un dato che si ordina benissimo in memoria.
    func fetchLastCompletedImport(userID: String) async throws -> TitlesImportJob? {
        let snapshot = try await db.collection("users")
            .document(userID)
            .collection("imports")
            .whereField("status", isEqualTo: "completed")
            .limit(to: 12)
            .getDocuments()

        var best: TitlesImportJob?
        var bestMs: TimeInterval = -1
        for doc in snapshot.documents {
            let data = doc.data()
            let ms = (data["updatedAt"] as? Timestamp)?.dateValue().timeIntervalSince1970 ?? 0
            guard ms > bestMs else { continue }
            bestMs = ms
            best = TitlesImportJob(
                id: doc.documentID,
                status: "completed",
                totalRows: FirestoreValueReader.int(data, key: "totalRows") ?? 0,
                processedCount: FirestoreValueReader.int(data, key: "processedCount") ?? 0,
                matchedCount: FirestoreValueReader.int(data, key: "matchedCount") ?? 0,
                unresolvedCount: FirestoreValueReader.int(data, key: "unresolvedCount") ?? 0,
                errorCount: FirestoreValueReader.int(data, key: "errorCount") ?? 0,
                error: FirestoreValueReader.string(data, key: "error"),
                source: FirestoreValueReader.string(data, key: "source"),
                importedTitleCount: FirestoreValueReader.int(data, key: "importedTitleCount") ?? 0,
                skippedCount: FirestoreValueReader.int(data, key: "skippedCount") ?? 0
            )
        }
        return best
    }

    /// STEP 4 (quick confirm): dispone delle righe rimaste `awaiting_confirmation`.
    /// `resolutions` può contenere fino a 500 decisioni esplicite per riga
    /// (`itemId` + una fra `titleId`/`skip:true`/`acceptSuggestion:true`);
    /// `skipRemaining:true` salta TUTTO ciò che resta non risolto dopo aver
    /// applicato le `resolutions` e completa il job in un'unica chiamata —
    /// il path "zero decisioni" usato da "Importa i titoli trovati"/"Salta
    /// tutti". Idempotente: una seconda chiamata su un job già `completed`
    /// ritorna `alreadyCompleted:true` senza riscrivere nulla.
    func confirmImport(importId: String, resolutions: [TitlesImportResolution] = [], skipRemaining: Bool = false) async throws -> TitlesImportConfirmResult {
        var payload: [String: Any] = ["importId": importId]
        if !resolutions.isEmpty {
            payload["resolutions"] = resolutions.map { $0.payload }
        }
        if skipRemaining {
            payload["skipRemaining"] = true
        }
        let data = try await callImportFunction("confirmTitlesImport", payload: payload, timeout: 120)
        guard let dict = data as? [String: Any],
              let responseImportId = FirestoreValueReader.string(dict, key: "importId"),
              let status = FirestoreValueReader.string(dict, key: "status")
        else {
            throw TitlesImportError.invalidResponse
        }
        return TitlesImportConfirmResult(
            ok: FirestoreValueReader.bool(dict, key: "ok") ?? true,
            importId: responseImportId,
            status: status,
            resolvedCount: FirestoreValueReader.int(dict, key: "resolvedCount") ?? 0,
            importedTitleCount: FirestoreValueReader.int(dict, key: "importedTitleCount") ?? 0,
            skippedCount: FirestoreValueReader.int(dict, key: "skippedCount") ?? 0,
            unresolvedCount: FirestoreValueReader.int(dict, key: "unresolvedCount") ?? 0,
            alreadyCompleted: FirestoreValueReader.bool(dict, key: "alreadyCompleted") ?? false
        )
    }

    /// Righe NON ancora risolte (`resolved==false && skip==false`) da mostrare
    /// nello Screen B. Stessa query lato client di `confirmTitlesImport`
    /// (`skipRemaining` sweep) e del picker web — nessun indice composito
    /// necessario: due filtri di sola uguaglianza sono coperti dagli indici
    /// per-campo automatici di Firestore.
    func fetchUnresolvedItems(userID: String, importID: String, limit: Int = 500) async throws -> [TitlesImportUnresolvedItem] {
        let snapshot = try await db.collection("users")
            .document(userID)
            .collection("imports")
            .document(importID)
            .collection("items")
            .whereField("resolved", isEqualTo: false)
            .whereField("skip", isEqualTo: false)
            .limit(to: limit)
            .getDocuments()

        return snapshot.documents.map { doc in
            let data = doc.data()
            let itemId = FirestoreValueReader.string(data, key: "itemId") ?? doc.documentID
            var suggestion: TitlesImportSuggestion?
            if let suggestionMap = data["suggestion"] as? [String: Any],
               let tmdbId = FirestoreValueReader.int(suggestionMap, key: "tmdbId") {
                suggestion = TitlesImportSuggestion(
                    tmdbId: tmdbId,
                    name: FirestoreValueReader.string(suggestionMap, key: "name") ?? "",
                    year: FirestoreValueReader.int(suggestionMap, key: "year"),
                    posterPath: FirestoreValueReader.string(suggestionMap, key: "posterPath"),
                    mediaType: FirestoreValueReader.string(suggestionMap, key: "mediaType")
                )
            }
            return TitlesImportUnresolvedItem(
                itemId: itemId,
                rawTitle: FirestoreValueReader.string(data, key: "rawTitle"),
                kind: FirestoreValueReader.string(data, key: "kind"),
                refKind: FirestoreValueReader.string(data, key: "refKind"),
                seriesNameGuess: FirestoreValueReader.string(data, key: "seriesNameGuess"),
                movieNameGuess: FirestoreValueReader.string(data, key: "movieNameGuess"),
                seasonNumber: FirestoreValueReader.int(data, key: "seasonNumber"),
                episodeNumber: FirestoreValueReader.int(data, key: "episodeNumber"),
                episodeNameGuess: FirestoreValueReader.string(data, key: "episodeNameGuess"),
                confidence: FirestoreValueReader.double(data, key: "confidence"),
                strategy: FirestoreValueReader.string(data, key: "strategy"),
                suggestion: suggestion
            )
        }
    }
}

enum TitlesImportError: LocalizedError {
    case invalidResponse
    case unreadableFile
    case fileTooLarge
    case archiveNotSupported
    case zipMissingTvTimeFiles

    var errorDescription: String? {
        switch self {
        case .invalidResponse:
            return String(localized: "Risposta import non valida.")
        case .zipMissingTvTimeFiles:
            return String(localized: "Nello ZIP non ho trovato i dati di TV Time (tracking-prod-records.csv / -v2.csv, oppure tvtime-movies/series-*.json). Assicurati di caricare l'export completo di TV Time.")
        case .unreadableFile:
            return String(localized: "Non riesco a leggere questo file. Scegli un file CSV o JSON (non un'immagine o un archivio).")
        case .fileTooLarge:
            return String(localized: "Questo file è troppo grande per l'import diretto. Carica l'export dal sito somto.it/import.")
        case .archiveNotSupported:
            return String(localized: "Questo è un archivio ZIP. Estrailo prima (nell'app File tieni premuto sullo ZIP e tocca «Estrai») e poi scegli i file CSV o JSON al suo interno.")
        }
    }
}
