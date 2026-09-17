import SwiftUI
import WidgetKit

/// I widget di Somto.
///
/// Tre, e sono i tre gradini: "Prossime uscite" legge un endpoint pubblico
/// (nessun utente, nessuna sessione), "Watchlist" legge il riassunto che l'app
/// lascia in un App Group (dati dell'utente, sola lettura), "Segna episodio"
/// SCRIVE — l'unico che lo fa, con il token depositato dall'app in un keychain
/// condiviso (vedi `WidgetAuthBridge.swift`).
@main
struct SomtoWidgetsBundle: WidgetBundle {
    var body: some Widget {
        UpcomingReleasesWidget()
        WatchlistWidget()
        EpisodeCheckWidget()
    }
}
