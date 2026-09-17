@preconcurrency import FirebaseAuth
@preconcurrency import FirebaseFirestore
import Foundation

/// Helper transazione client-side per le create soggette a rate-limit lato
/// rules. Le rules (`firestore.rules`) attribuiscono a
/// `users/{uid}/rateLimits/{action}` uno schema rigido `{count, resetAt}` e
/// richiedono che la create del doc bersaglio avvenga atomicamente con
/// l'aggiornamento del counter. Senza un counter incrementato in transazione
/// la rule `rateLimitOk(uid, action, cap)` rifiuta la create.
///
/// Window: 24h sliding. Cap per azione:
/// - `.recommendations`: 50/giorno
/// - `.reports`: 20/giorno
enum RateLimitAction: String {
    case recommendations
    case reports

    var cap: Int {
        switch self {
        case .recommendations: return 50
        case .reports: return 20
        }
    }
}

/// Errore lanciato quando l'utente ha raggiunto il cap nella finestra
/// corrente. Il chiamante può intercettarlo per mostrare un messaggio dedicato.
struct RateLimitExceededError: LocalizedError {
    let action: RateLimitAction
    let cap: Int

    var errorDescription: String? {
        switch action {
        case .recommendations:
            return "Hai raggiunto il limite giornaliero di suggerimenti (\(cap)/giorno)."
        case .reports:
            return "Hai raggiunto il limite giornaliero di segnalazioni (\(cap)/giorno)."
        }
    }
}

/// NB ISOLAMENTO: questo enum deve restare `nonisolated` (NON `@MainActor`).
/// Il blocco di `runTransaction` viene eseguito da Firestore sulla sua queue
/// interna: se la closure eredita l'isolamento `@MainActor` dal contesto,
/// il runtime Swift 6 fa `dispatch_assert_queue` e l'app muore in SIGTRAP
/// (crash reale in produzione: invio suggerimento, 1.5.0/2026072803,
/// iOS 26.4 — `_dispatch_assert_queue_fail` in `createWithRateLimit`).
/// Stesso pattern di `UserRepository.commitDisplayNameReservation`.
enum RateLimitedCreate {
    private static let windowSeconds: TimeInterval = 24 * 60 * 60

    /// Esegue in transazione:
    ///   1) read di `users/{uid}/rateLimits/{action}`
    ///   2) decisione count: nuova finestra (reset a 1) o stessa finestra
    ///      (count+1)
    ///   3) write counter (create/update con solo `{count, resetAt}` — le
    ///      rules enforce `hasOnly` su quelle key, NON includere updatedAt)
    ///   4) `setData(payload, forDocument: targetRef)`
    ///
    /// NB: lo schema del counter è IDENTICO a quello richiesto dalle rules.
    /// Non aggiungere altri campi (es. `updatedAt`) o la create/update
    /// fallirà col messaggio rules-side.
    ///
    /// Il `payload` deve contenere `createdAt` come `Timestamp` corrente
    /// (NON `FieldValue.serverTimestamp()`) perché le rules confrontano
    /// `request.resource.data.createdAt == request.time` e il serverTimestamp
    /// non è ancora risolto al momento del check.
    /// `payload` è `sending`: attraversa il confine di isolamento (il
    /// chiamante è spesso @MainActor, questa funzione no) — i chiamanti
    /// devono costruirlo localmente, mai passare dict condivisi.
    nonisolated static func createWithRateLimit(
        uid: String,
        action: RateLimitAction,
        targetRef: DocumentReference,
        payload: sending [String: Any]
    ) async throws -> String {
        let db = Firestore.firestore()
        let counterRef = db.collection("users")
            .document(uid)
            .collection("rateLimits")
            .document(action.rawValue)

        var capturedError: Error?

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            db.runTransaction({ (txn, errPtr) -> Any? in
                let counterSnap: DocumentSnapshot
                do {
                    counterSnap = try txn.getDocument(counterRef)
                } catch {
                    errPtr?.pointee = error as NSError
                    return nil
                }

                let now = Date()
                let newCount: Int
                let newResetAt: Date

                if !counterSnap.exists {
                    // Prima azione assoluta: crea il counter.
                    newCount = 1
                    newResetAt = now.addingTimeInterval(Self.windowSeconds)
                } else {
                    let data = counterSnap.data() ?? [:]
                    let prevReset = (data["resetAt"] as? Timestamp)?.dateValue()
                        ?? Date(timeIntervalSince1970: 0)
                    if prevReset <= now {
                        // Finestra scaduta: reset.
                        newCount = 1
                        newResetAt = now.addingTimeInterval(Self.windowSeconds)
                    } else {
                        let prevCount = (data["count"] as? Int) ?? 0
                        if prevCount >= action.cap {
                            let err = RateLimitExceededError(action: action, cap: action.cap)
                            capturedError = err
                            errPtr?.pointee = err as NSError
                            return nil
                        }
                        newCount = prevCount + 1
                        newResetAt = prevReset
                    }
                }

                // IMPORTANTE: nessun campo extra (rules `hasOnly(["count", "resetAt"])`).
                txn.setData([
                    "count": newCount,
                    "resetAt": Timestamp(date: newResetAt)
                ], forDocument: counterRef)

                txn.setData(payload, forDocument: targetRef)
                return nil
            }) { (_, error) in
                if let error {
                    // Se l'errore è il nostro RateLimitExceededError già
                    // catturato, rilancialo come tipo proprio.
                    if let captured = capturedError {
                        continuation.resume(throwing: captured)
                    } else {
                        continuation.resume(throwing: error)
                    }
                } else {
                    continuation.resume(returning: ())
                }
            }
        }

        return targetRef.documentID
    }
}
