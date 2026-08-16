import FirebaseFirestore
import Foundation

// Traduce un errore qualsiasi in una frase che una persona puo' leggere.
//
// PERCHE' ESISTE — 120 punti dell'app scrivevano
// `errorMessage = error.localizedDescription` e mettevano in schermo la stringa
// che arriva da Firestore, dalle Functions o da URLSession. Quel testo:
//
//   - e' scritto per uno sviluppatore ("Missing or insufficient permissions.");
//   - resta in **inglese** anche con l'app in italiano, perche' viene dall'SDK
//     e non passa dal catalogo di traduzione;
//   - non dice all'utente cosa puo' fare.
//
// E' esattamente la stringa che gli utenti si sono letti durante l'incidente di
// limbo auth al cambio account.
//
// COSA NON FA — non registra niente e non decide se mostrare. L'errore tecnico
// va comunque a `SilentFailure` quando lo si inghiotte: i due sono
// complementari, non alternativi (docs/context/IOS_CODE_STYLE.md §5.1).
//
// COPY — i cinque messaggi esistono gia' identici su iOS e sul web
// (`public/js/i18n/en.js`). Non aggiungere un sesto caso senza aver prima
// cercato la frase su entrambe le piattaforme: la chiave di traduzione E' la
// stringa italiana, quindi una variante e' una traduzione in piu' da mantenere.
enum UserFacingError {

    /// Il messaggio da mostrare all'utente per questo errore.
    static func message(for error: Error) -> String {
        // Gli errori di dominio dell'app conformano gia' a `LocalizedError` e
        // hanno una frase scritta da noi: quella vince sempre.
        if let localized = error as? LocalizedError, let description = localized.errorDescription {
            return description
        }
        return kind(of: error).message
    }

    // MARK: - Classificazione

    enum Kind {
        case offline
        case notAllowed
        case signInAgain
        case notFound
        case rateLimited
        case unexpected

        var message: String {
            switch self {
            case .offline:
                String(localized: "Connessione assente. Controlla la rete e riprova.")
            case .notAllowed:
                String(localized: "Permessi insufficienti.")
            case .signInAgain:
                String(localized: "Per sicurezza accedi di nuovo e riprova.")
            case .notFound:
                String(localized: "Contenuto non trovato")
            case .rateLimited:
                // Sesto caso, aggiunto seguendo il protocollo del commento in
                // testa: la frase ESISTE gia' identica sul web
                // (`public/js/i18n/en.js`), mancava solo su iOS. Non e' copy
                // nuovo, e' una divergenza iOS/web chiusa.
                //
                // `kind(of:)` non la produce mai: nessun errore Firestore o
                // URLSession segnala un rate limit. La emette solo
                // `CloudFunctionsCaller.CallableError`, che legge lo status
                // `RESOURCE_EXHAUSTED` dell'envelope callable.
                String(localized: "Troppi tentativi. Riprova tra poco.")
            case .unexpected:
                String(localized: "Qualcosa è andato storto. Riprova.")
            }
        }
    }

    /// Esposta per i test: la classificazione e' la parte che puo' sbagliare,
    /// il testo e' solo una tabella.
    static func kind(of error: Error) -> Kind {
        if let urlError = error as? URLError {
            return urlError.isOffline ? .offline : .unexpected
        }

        let nsError = error as NSError
        switch nsError.domain {
        case FirestoreErrorDomain, "com.firebase.functions":
            return firebaseKind(code: nsError.code)
        case NSURLErrorDomain:
            return URLError(URLError.Code(rawValue: nsError.code)).isOffline ? .offline : .unexpected
        case "FIRAuthErrorDomain":
            // 17014 = requiresRecentLogin. L'utente e' autenticato ma il token
            // e' troppo vecchio per un'operazione sensibile: rifare login
            // e' letteralmente cio' che deve fare.
            return nsError.code == 17_014 ? .signInAgain : .unexpected
        default:
            return .unexpected
        }
    }

    /// Firestore e Cloud Functions condividono i codici gRPC, quindi la stessa
    /// tabella vale per entrambi i domini.
    private static func firebaseKind(code: Int) -> Kind {
        switch code {
        case FirestoreErrorCode.permissionDenied.rawValue:
            .notAllowed
        case FirestoreErrorCode.unauthenticated.rawValue:
            .signInAgain
        case FirestoreErrorCode.notFound.rawValue:
            .notFound
        case FirestoreErrorCode.unavailable.rawValue,
             FirestoreErrorCode.deadlineExceeded.rawValue:
            .offline
        default:
            .unexpected
        }
    }
}

private extension URLError {
    /// Rete assente o caduta a meta': per l'utente sono la stessa cosa.
    var isOffline: Bool {
        [.notConnectedToInternet, .networkConnectionLost, .dataNotAllowed, .timedOut].contains(code)
    }
}
