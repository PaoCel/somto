import Foundation

/// Conta quali *fallback di forma documento* scattano ancora in produzione.
///
/// IL PROBLEMA CHE RISOLVE — i mapper Firestore contengono 191 operatori `??`
/// su ~632 righe. Non sono sciatteria: sono la risposta a dati scritti da
/// quattro produttori diversi (iOS, web, Cloud Functions, importer) su anni.
/// Ma **nessuno sa quali servano ancora**. Alcuni proteggono da forme che forse
/// non esistono piu' da un anno; altri tengono in piedi meta' del catalogo. Non
/// c'e' modo di distinguerli, perche' quando un fallback scatta non lo registra
/// nessuno.
///
/// Con questi numeri in mano i rami morti si cancellano senza paura, e quelli
/// vivi smettono di essere debito: diventano un requisito documentato.
///
/// VOLUME — la parte progettata. Il decoding gira su ogni documento letto,
/// quindi migliaia di volte per sessione: mandare un evento a ogni scatto
/// sarebbe insostenibile e verrebbe campionato via. Qui si registra **la prima
/// volta per sessione** di ogni chiave distinta. La domanda a cui si risponde
/// non e' "quante volte" ma "esiste ancora": per quello basta una volta, e il
/// volume e' limitato dal numero di chiavi (~20), non dal traffico.
enum FallbackProbe {

    /// Dove finiscono le chiavi osservate. Iniettato al boot da `AppContainer`
    /// per non legare i mapper puri a Firebase: `TitleParsing` resta testabile
    /// senza SDK.
    nonisolated(unsafe) static var reporter: (@Sendable (String) -> Void)?

    private static let lock = NSLock()
    nonisolated(unsafe) private static var seen: Set<String> = []

    /// Segnala che un ramo di fallback e' stato preso.
    ///
    /// - Parameter key: identificatore stabile e leggibile in una dashboard,
    ///   es. `"Title.tmdbId.fromMeta"`. Mai dati dell'utente.
    static func hit(_ key: String) {
        lock.lock()
        let isNew = seen.insert(key).inserted
        lock.unlock()
        guard isNew else { return }
        reporter?(key)
    }

    /// Le chiavi viste finora in questa sessione. Serve ai test e a un
    /// eventuale dump diagnostico.
    static var observedKeys: Set<String> {
        lock.lock(); defer { lock.unlock() }
        return seen
    }

    /// Solo per i test: azzera la memoria di sessione.
    static func resetForTesting() {
        lock.lock(); seen.removeAll(); lock.unlock()
    }

    /// Zucchero per le catene `??`: restituisce il valore e, se non e' nil,
    /// segnala che quel ramo e' servito.
    ///
    /// ```swift
    /// tmdbId: FirestoreValueReader.int(data, key: "tmdbId")
    ///     ?? FallbackProbe.used("Title.tmdbId.fromMeta", FirestoreValueReader.int(meta, key: "tmdbId"))
    ///     ?? FallbackProbe.used("Title.tmdbId.fromDocID", canonical?.tmdbId)
    /// ```
    ///
    /// Nota: l'argomento e' `@autoclosure` cosi' il ramo successivo non viene
    /// nemmeno calcolato quando il precedente ha gia' dato un valore.
    static func used<T>(_ key: String, _ value: @autoclosure () -> T?) -> T? {
        guard let value = value() else { return nil }
        hit(key)
        return value
    }
}
