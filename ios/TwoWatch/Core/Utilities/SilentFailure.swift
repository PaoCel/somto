import FirebaseFirestore
import Foundation
#if !DEBUG
@preconcurrency import FirebaseCrashlytics
#endif

/// Registra gli errori che l'app decide di NON mostrare all'utente.
///
/// PERCHE' ESISTE — l'app ha 169 `try? await`. In molti casi tacere e' la
/// scelta giusta: una sezione accessoria che non carica non deve bloccare la
/// schermata. Ma "non mostrarlo all'utente" non deve voler dire "non saperlo":
/// oggi una sezione che fallisce e' indistinguibile da una sezione senza dati,
/// e nessuno se ne accorge finche' qualcuno non segnala.
///
/// Crashlytics era gia' configurato (`setUserID`, metadati custom) ma
/// `recordError` non veniva chiamato da nessuna parte: nessun non-fatal e'
/// mai arrivato.
///
/// COSA NON REGISTRA — e questo e' il punto piu' importante del file. Un
/// reporter che manda tutto viene silenziato entro una settimana. Si scartano:
///
///   - le **cancellazioni**: navigare via da una schermata cancella i suoi
///     task, e' funzionamento normale, non un errore;
///   - la **rete assente**: un utente in metropolitana ne genererebbe decine
///     al minuto, e non c'e' niente da correggere lato codice.
///
/// Resta quello su cui si puo' agire: permessi negati, dati malformati,
/// backend che risponde male.
enum SilentFailure {

    /// - Parameters:
    ///   - error: l'errore inghiottito.
    ///   - context: dove e' successo, in forma leggibile in un report
    ///     Crashlytics — es. `"TitleDetail.providers"`. Non mettere PII.
    static func record(
        _ error: Error,
        context: String,
        file: StaticString = #fileID,
        line: UInt = #line
    ) {
        guard isWorthReporting(error) else { return }

        // Un `DiagnosableError` tiene il dettaglio tecnico separato dalla frase
        // mostrata: senza questa riga, ripulire `errorDescription` per non far
        // leggere JSON all'utente lo cancellerebbe anche dal report, che e'
        // l'unico posto dove serviva davvero.
        let detail = (error as? DiagnosableError)?.diagnosticDescription
            ?? (error as NSError).localizedDescription

        #if DEBUG
        print("[silent] \(context) — \(detail)  (\(file):\(line))")
        #else
        let nsError = error as NSError
        Crashlytics.crashlytics().record(
            error: NSError(
                domain: "SomtoSilentFailure",
                code: nsError.code,
                userInfo: [
                    NSLocalizedDescriptionKey: detail,
                    "context": context,
                    "originalDomain": nsError.domain,
                    "site": "\(file):\(line)"
                ]
            )
        )
        #endif
    }

    /// Esposto per i test: la logica di filtro e' la parte che decide se il
    /// reporting sara' utile o solo rumore.
    static func isWorthReporting(_ error: Error) -> Bool {
        if error is CancellationError { return false }

        let nsError = error as NSError

        // Task cancellato (Foundation e URLSession usano codici diversi).
        if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled { return false }
        if nsError.domain == NSCocoaErrorDomain && nsError.code == NSUserCancelledError { return false }

        // Rete assente o server irraggiungibile: nulla da correggere nel codice.
        if nsError.domain == NSURLErrorDomain {
            let offline: Set<Int> = [
                NSURLErrorNotConnectedToInternet,
                NSURLErrorNetworkConnectionLost,
                NSURLErrorTimedOut,
                NSURLErrorDataNotAllowed,
                NSURLErrorInternationalRoamingOff
            ]
            if offline.contains(nsError.code) { return false }
        }

        if nsError.domain == FirestoreErrorDomain {
            let transient: Set<Int> = [
                FirestoreErrorCode.cancelled.rawValue,
                FirestoreErrorCode.unavailable.rawValue,
                FirestoreErrorCode.deadlineExceeded.rawValue
            ]
            if transient.contains(nsError.code) { return false }
        }

        return true
    }
}
