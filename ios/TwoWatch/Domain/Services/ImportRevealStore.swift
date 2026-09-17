import Foundation
import Observation

/// Ricorda per quali import il reveal di fine import e' gia' stato mostrato.
///
/// PERCHE' NON E' UNA CHIAVE PER IMPORT — la versione precedente scriveva
/// `home_import_reveal_seen_<importID>`: una chiave nuova a ogni import, mai
/// cancellata. `UserDefaults` viene caricato per intero all'avvio dell'app, per
/// cui una chiave che cresce coi dati dell'utente e' una perdita su disco lenta.
/// Qui c'e' **una** chiave con dentro una lista, con un tetto esplicito.
///
/// Il tetto e' sicuro perche' il banner e' un reveal una-tantum sull'**ultimo**
/// import completato: dimenticare un id vecchio di venti import non ripresenta
/// niente. Nel dubbio la lista e' ordinata dal piu' recente.
@Observable
@MainActor
final class ImportRevealStore {

    /// Quanti id si conservano. Venti import sono gia' molto piu' di quanti ne
    /// faccia un utente reale.
    /// `nonisolated`: la migrazione delle chiavi legacy gira all'avvio fuori
    /// dal main actor e ha bisogno dello stesso tetto.
    nonisolated static let limit = 20

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func hasSeenReveal(importID: String) -> Bool {
        seenIDs.contains(importID)
    }

    func markRevealSeen(importID: String) {
        var ids = seenIDs
        ids.removeAll { $0 == importID }
        ids.insert(importID, at: 0)
        defaults.set(Array(ids.prefix(Self.limit)), forKey: SomtoDefaultsKey.importRevealSeenIDs)
    }

    private var seenIDs: [String] {
        defaults.stringArray(forKey: SomtoDefaultsKey.importRevealSeenIDs) ?? []
    }
}
