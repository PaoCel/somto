import AppIntents
import Foundation

/// Un titolo del catalogo Somto, come lo vede Siri/Scorciatoie/Spotlight.
struct SomtoTitleEntity: AppEntity {
    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Titolo")
    static let defaultQuery = SomtoTitleQuery()

    /// Id del documento Somto.
    ///
    /// Per un risultato TMDB non ancora in catalogo e' gia' l'id che il
    /// documento **avra'** una volta creato: `TMDBSearchResult.id` e il
    /// `documentID` calcolato da `TitleRepository.importTMDBTitle` sono la
    /// stessa stringa (`tmdb_<tipo>_<tmdbId>`). Cosi' l'identificatore non
    /// cambia sotto i piedi di una scorciatoia salvata nel momento in cui
    /// qualcuno aggiunge quel titolo al catalogo.
    let id: String
    let name: String
    let year: Int?
    let mediaType: MediaType

    /// Valorizzato solo per i risultati TMDB non ancora in catalogo. Serve a
    /// `AddToWatchlistIntent` per crearli **al momento della scelta**, non
    /// mentre venivano soltanto mostrati nella disambiguazione.
    let pendingTMDBID: Int?

    /// Nome + tipo + anno, non solo il nome: film e serie omonimi esistono, e
    /// il catalogo ha gia' collisioni reali fra titoli quasi identici ("La Casa
    /// di Carta" / "La Casa di Carta Korea"). Un elenco di nomi nudi renderebbe
    /// la disambiguazione una scelta alla cieca.
    var displayRepresentation: DisplayRepresentation {
        var parts = [mediaType.label]
        if let year {
            parts.append(String(year))
        }
        return DisplayRepresentation(
            title: "\(name)",
            subtitle: "\(parts.joined(separator: " · "))"
        )
    }
}

extension SomtoTitleEntity {
    init(_ title: Title) {
        self.init(id: title.id, name: title.name, year: title.year, mediaType: title.type, pendingTMDBID: nil)
    }

    init(_ result: TMDBSearchResult) {
        self.init(
            id: result.id,
            name: result.title,
            year: result.year,
            mediaType: result.mediaType,
            pendingTMDBID: result.tmdbId
        )
    }
}

struct SomtoTitleQuery: EntityStringQuery {
    func entities(for identifiers: [SomtoTitleEntity.ID]) async throws -> [SomtoTitleEntity] {
        try await SomtoTitleLookup.entities(for: identifiers)
    }

    func entities(matching string: String) async throws -> [SomtoTitleEntity] {
        try await SomtoTitleLookup.entities(matching: string)
    }
}

/// La ricerca vera, isolata su MainActor: i repository lo sono, e i metodi di
/// `EntityQuery` no. Un solo salto qui invece di uno per chiamata.
@MainActor
enum SomtoTitleLookup {
    private static let resultLimit = 8

    /// Reidratazione di un'entity salvata in una scorciatoia.
    ///
    /// Risponde solo per i titoli che **esistono** nel catalogo: un id
    /// `tmdb_*` mai aggiunto da nessuno non e' ricostruibile senza rifare la
    /// ricerca, e inventare un risultato sarebbe peggio che non rispondere.
    /// Il caso si autoestingue: alla prima esecuzione dell'intent il titolo
    /// entra in catalogo e da li' in poi si reidrata sempre.
    static func entities(for identifiers: [String]) async throws -> [SomtoTitleEntity] {
        let repository = SomtoIntentContext.shared.titleRepository
        var found: [SomtoTitleEntity] = []
        for identifier in identifiers {
            do {
                if let title = try await repository.fetchTitle(id: identifier) {
                    found.append(SomtoTitleEntity(title))
                }
            } catch {
                SilentFailure.record(error, context: "Intent.entitiesForIdentifiers")
            }
        }
        return found
    }

    /// Catalogo Somto prima, TMDB solo se il catalogo non ha niente.
    ///
    /// Il caso comune resta **una** query Firestore. Andare sempre anche su
    /// TMDB costerebbe un round trip al proxy per ogni invocazione: la cache di
    /// `searchTMDBCached` ha TTL 45s ed e' d'istanza, quindi in un processo
    /// headless effimero non e' mai calda.
    static func entities(matching string: String) async throws -> [SomtoTitleEntity] {
        let repository = SomtoIntentContext.shared.titleRepository

        let local = try await repository.searchTitles(string, limit: resultLimit)
        if !local.isEmpty {
            return local.map(SomtoTitleEntity.init)
        }

        // TMDB e' un completamento, non la fonte: il catalogo ha gia' risposto
        // "non ce l'ho". Se anche il proxy cade, "non trovo niente" resta la
        // risposta giusta — e l'errore va comunque tracciato (§5).
        do {
            return try await repository.searchTMDB(string, limit: resultLimit).map(SomtoTitleEntity.init)
        } catch {
            SilentFailure.record(error, context: "Intent.searchTMDB")
            return []
        }
    }
}
