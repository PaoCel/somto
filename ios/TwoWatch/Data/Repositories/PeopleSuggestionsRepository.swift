import Foundation

/// Una persona proposta dal server, con il motivo per cui viene proposta.
///
/// `sharedTitleNames` arriva gia' filtrato dal server (max 2): sono titoli
/// votati da entrambi, quindi contenuto pubblico in app. La frase ("3 voti in
/// comune, tra cui X") si compone qui sul client, cosi' resta tradotta.
struct PersonSuggestion: Identifiable, Hashable, Sendable {
    /// Una persona si propone per quello che avete in comune, una pagina per
    /// quello che pubblica: stessa riga, due motivazioni diverse.
    enum Kind: String, Sendable {
        case user
        case page
    }

    let id: String
    let kind: Kind
    let displayName: String
    let photoURL: URL?
    let sharedCount: Int
    let sharedTitleNames: [String]
    /// Descrizione della pagina. Vuota per le persone.
    let bio: String
}

@MainActor
final class PeopleSuggestionsRepository {

    /// Chiama `getPeopleSuggestions`. Il server tiene una cache di 12 ore, per
    /// cui aprire Community piu' volte al giorno non ricalcola niente.
    func fetchSuggestions(max limit: Int = 8) async throws -> [PersonSuggestion] {
        let payload: [String: any Sendable] = ["max": limit]
        let result = try await CloudFunctionsCaller.call(name: "getPeopleSuggestions", data: payload)

        guard
            let data = result.data as? [String: Any],
            let rows = data["people"] as? [[String: Any]]
        else { return [] }

        return rows.compactMap(Self.parse)
    }

    private static func parse(_ row: [String: Any]) -> PersonSuggestion? {
        guard
            let uid = row["uid"] as? String, !uid.isEmpty,
            let displayName = row["displayName"] as? String, !displayName.isEmpty
        else { return nil }

        let photo = (row["photoURL"] as? String).flatMap(URL.init(string:))
        let names = (row["sharedTitleNames"] as? [String])?.filter { !$0.isEmpty } ?? []

        return PersonSuggestion(
            id: uid,
            kind: PersonSuggestion.Kind(rawValue: (row["kind"] as? String) ?? "") ?? .user,
            displayName: displayName,
            photoURL: photo,
            sharedCount: (row["sharedCount"] as? Int) ?? names.count,
            sharedTitleNames: names,
            bio: (row["bio"] as? String) ?? ""
        )
    }
}
