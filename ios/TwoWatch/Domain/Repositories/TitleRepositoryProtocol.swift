import FirebaseFirestore
import Foundation

/// Superficie di `TitleRepository` consumata dal layer di presentazione.
///
/// PERCHE' ESISTE — `TitleRepository` e' una classe concreta che parla
/// direttamente a Firestore: un ViewModel che la riceve non e' istanziabile in
/// un test senza rete e senza un progetto Firebase. Non e' che i test non
/// fossero stati scritti, e' che non erano scrivibili (vedi
/// docs/IOS_REFACTOR_PLAN.md §2.3).
///
/// PERIMETRO — deliberatamente NON e' l'intera classe (130 metodi): qui stanno
/// solo i metodi che il layer di presentazione chiama davvero. Cresce quando un
/// ViewModel ne serve uno nuovo, non prima.
///
/// DEBITO NOTO — `fetchRatings` espone `DocumentSnapshot`, cioe' un tipo
/// Firestore, dentro un protocollo di dominio. Un fake puo' comunque
/// restituire `nil` come cursore, quindi non blocca i test; va sostituito con
/// un tipo cursore nostro quando si tocchera' la paginazione.
@MainActor
protocol TitleRepositoryProtocol: AnyObject, Sendable {
    // Lettura scheda
    func fetchTitle(id: String) async throws -> Title?
    func fetchTitleCredits(for title: Title) async throws -> TitleCredits
    func fetchRelatedTitles(for title: Title, limit: Int) async throws -> [Title]
    func fetchProviders(for titleID: String, region: String) async throws -> TitleProviders?
    func fetchTrailerURL(for title: Title) async throws -> URL?
    func fetchSeasonMetadata(for title: Title) async throws -> [TitleSeason]
    func listGenres(limit: Int) async throws -> [Genre]
    func searchTitlesForListBuilder(_ query: String, limit: Int) async throws -> [Title]
    func fetchMyEmotions(userID: String, limit: Int) async throws -> [TitleEmotionEntry]

    // Voti
    func fetchTitleLevelRatings(for titleID: String) async throws -> [Rating]
    func fetchRatings(
        for titleID: String,
        level: String?,
        cursor: DocumentSnapshot?,
        limit: Int
    ) async throws -> (ratings: [Rating], next: DocumentSnapshot?)
    func fetchDerivedRating(for titleID: String, userID: String) async throws -> DerivedRating?
    func submitRating(
        userID: String,
        titleID: String,
        level: String,
        season: Int?,
        episode: Int?,
        value: Double,
        reviewText: String?,
        details: RatingSocialDetails?
    ) async throws
    func deleteRating(
        userID: String,
        titleID: String,
        level: String,
        season: Int?,
        episode: Int?
    ) async throws
    func migrateRatingLevel(
        rating: Rating,
        toLevel newLevel: String,
        season: Int?,
        episode: Int?
    ) async throws

    // Aggiornamenti titolo
    func fetchTitleUpdates(
        for title: Title,
        includeOfficialUpdates: Bool
    ) async throws -> TitleUpdatesSnapshot
    /// Date di uscita future per piu' titoli in una manciata di query.
    /// Chiave = titleId, valore = data di uscita. I titoli senza uscita futura
    /// pubblicata semplicemente non compaiono nel risultato.
    func fetchUpcomingReleaseDates(titleIDs: [String]) async throws -> [String: Date]
    func fetchTitleUpdatePreference(userID: String, titleID: String) async throws -> TitleUpdatePreference
    /// Tutte le preferenze del viewer in una query. Chiave = titleId; i titoli
    /// su cui non ha scelto niente (cioe' `auto`) non compaiono.
    func fetchTitleUpdatePreferences(userID: String) async throws -> [String: TitleUpdatePreference]
    func setTitleUpdatePreference(
        userID: String,
        titleID: String,
        preference: TitleUpdatePreference
    ) async throws

    // Personaggi
    func fetchTitleCharacterAggregate(titleID: String) async throws -> TitleCharacterAggregate?

    // TMDB / redazione
    @discardableResult
    func enrichTitleAssets(
        title: Title,
        includeTrailer: Bool,
        includeCast: Bool
    ) async throws -> TitleEnrichmentResult
    func refreshTitleFromTMDB(titleID: String) async throws
    func refreshTitleFromTMDBIfNeeded(titleID: String) async throws -> TitleRefreshResult
    func updateEditorialContent(
        title: Title,
        currentUser: AppUser,
        overview: String?,
        trailerInput: String?
    ) async throws
}

/// I requisiti di protocollo in Swift non ammettono valori di default per i
/// parametri. Senza queste convenienze ogni call site esistente andrebbe
/// riscritto per passare argomenti che prima erano impliciti — cioe' un
/// refactoring "solo di tipi" diventerebbe una modifica diffusa del codice.
/// I default replicano quelli delle firme concrete.
extension TitleRepositoryProtocol {
    func fetchMyEmotions(userID: String) async throws -> [TitleEmotionEntry] {
        try await fetchMyEmotions(userID: userID, limit: 300)
    }

    func fetchRelatedTitles(for title: Title) async throws -> [Title] {
        try await fetchRelatedTitles(for: title, limit: 12)
    }

    func listGenres() async throws -> [Genre] {
        try await listGenres(limit: 200)
    }

    func fetchRatings(
        for titleID: String,
        level: String? = nil,
        cursor: DocumentSnapshot? = nil
    ) async throws -> (ratings: [Rating], next: DocumentSnapshot?) {
        try await fetchRatings(for: titleID, level: level, cursor: cursor, limit: 50)
    }

    func submitRating(
        userID: String,
        titleID: String,
        level: String,
        season: Int?,
        episode: Int?,
        value: Double,
        reviewText: String?
    ) async throws {
        try await submitRating(
            userID: userID,
            titleID: titleID,
            level: level,
            season: season,
            episode: episode,
            value: value,
            reviewText: reviewText,
            details: nil
        )
    }

    func deleteRating(
        userID: String,
        titleID: String,
        level: String = "title",
        season: Int? = nil,
        episode: Int? = nil
    ) async throws {
        try await deleteRating(
            userID: userID,
            titleID: titleID,
            level: level,
            season: season,
            episode: episode
        )
    }

    func fetchTitleUpdates(for title: Title) async throws -> TitleUpdatesSnapshot {
        try await fetchTitleUpdates(for: title, includeOfficialUpdates: true)
    }

    @discardableResult
    func enrichTitleAssets(title: Title) async throws -> TitleEnrichmentResult {
        try await enrichTitleAssets(title: title, includeTrailer: true, includeCast: true)
    }
}

extension TitleRepository: TitleRepositoryProtocol {}
