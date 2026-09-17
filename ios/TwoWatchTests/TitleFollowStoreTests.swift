import XCTest
@testable import Somto

/// Lo store che tiene "quali titoli seguo" per i bottoni delle card social.
///
/// Cosa si copre: le tre cose che, se si rompono, l'utente vede — il bottone
/// che nasce nello stato sbagliato, il "Seguito" che resta acceso dopo un
/// errore di scrittura, e la mappa del vecchio account che sopravvive al
/// cambio utente.
@MainActor
final class TitleFollowStoreTests: XCTestCase {

    private func makeStore(
        preferences: [String: TitleUpdatePreference] = [:]
    ) -> (TitleFollowStore, FakeTitleRepository) {
        let repository = FakeTitleRepository()
        repository.stubUpdatePreferences = preferences
        return (TitleFollowStore(titleRepository: repository), repository)
    }

    // MARK: - Caricamento

    func testLoadReadsPreferencesOncePerUser() async {
        let (store, repository) = makeStore(preferences: ["title-dune-2": .follow])

        await store.load(userID: "u1")
        await store.load(userID: "u1")

        XCTAssertEqual(repository.recorder.count("fetchTitleUpdatePreferences"), 1)
        XCTAssertTrue(store.isFollowing("title-dune-2"))
        XCTAssertFalse(store.isFollowing("title-the-bear"))
    }

    func testLoadClearsStateOnUserChange() async {
        let (store, repository) = makeStore(preferences: ["title-dune-2": .follow])
        await store.load(userID: "u1")

        repository.stubUpdatePreferences = [:]
        await store.load(userID: "u2")

        XCTAssertEqual(repository.recorder.count("fetchTitleUpdatePreferences"), 2)
        XCTAssertFalse(store.isFollowing("title-dune-2"))
    }

    func testLoadWithoutUserEmptiesPreferences() async {
        let (store, repository) = makeStore(preferences: ["title-dune-2": .follow])
        await store.load(userID: "u1")

        await store.load(userID: nil)

        XCTAssertFalse(store.isFollowing("title-dune-2"))
        XCTAssertEqual(repository.recorder.count("fetchTitleUpdatePreferences"), 1)
    }

    /// Il caricamento e' accessorio: se fallisce il bottone nasce spento e
    /// resta usabile, ma il tentativo successivo deve poter riprovare.
    func testLoadFailureLeavesStoreEmptyAndRetryable() async {
        let (store, repository) = makeStore(preferences: ["title-dune-2": .follow])
        repository.errorFor["fetchTitleUpdatePreferences"] = FakeRepositoryError.generic

        await store.load(userID: "u1")
        XCTAssertFalse(store.isFollowing("title-dune-2"))

        repository.errorFor.removeValue(forKey: "fetchTitleUpdatePreferences")
        await store.load(userID: "u1")

        XCTAssertEqual(repository.recorder.count("fetchTitleUpdatePreferences"), 2)
        XCTAssertTrue(store.isFollowing("title-dune-2"))
    }

    // MARK: - Toggle

    func testToggleFollowWritesFollowThenBackToAutomatic() async throws {
        let (store, repository) = makeStore()
        await store.load(userID: "u1")

        try await store.toggleFollow(titleID: "title-dune-2", userID: "u1")
        XCTAssertTrue(store.isFollowing("title-dune-2"))
        XCTAssertEqual(repository.savedUpdatePreferences["title-dune-2"], .follow)

        try await store.toggleFollow(titleID: "title-dune-2", userID: "u1")
        XCTAssertFalse(store.isFollowing("title-dune-2"))
        XCTAssertEqual(repository.savedUpdatePreferences["title-dune-2"], .automatic)
    }

    /// Un titolo silenziato dalla scheda si puo' seguire da un post: la scelta
    /// piu' recente vince.
    func testToggleFollowOverridesMutedPreference() async throws {
        let (store, repository) = makeStore(preferences: ["title-dune-2": .muted])
        await store.load(userID: "u1")
        XCTAssertFalse(store.isFollowing("title-dune-2"))

        try await store.toggleFollow(titleID: "title-dune-2", userID: "u1")

        XCTAssertTrue(store.isFollowing("title-dune-2"))
        XCTAssertEqual(repository.savedUpdatePreferences["title-dune-2"], .follow)
    }

    /// L'errore risale a chi chiama (che lo mostra), e lo stato NON cambia:
    /// un "Seguito" acceso su una scrittura negata sarebbe una bugia.
    func testToggleFollowRethrowsAndKeepsPreviousState() async {
        let (store, repository) = makeStore()
        await store.load(userID: "u1")
        repository.errorFor["setTitleUpdatePreference"] = FakeRepositoryError.generic

        do {
            try await store.toggleFollow(titleID: "title-dune-2", userID: "u1")
            XCTFail("toggleFollow dovrebbe rilanciare")
        } catch {
            XCTAssertEqual(error as? FakeRepositoryError, .generic)
        }

        XCTAssertFalse(store.isFollowing("title-dune-2"))
        XCTAssertFalse(store.isSaving("title-dune-2"))
    }

    /// Doppio tap: la seconda chiamata mentre la prima e' in volo non deve
    /// mandare una seconda scrittura (che sarebbe quella opposta).
    func testConcurrentToggleIsIgnoredWhileSaving() async throws {
        let (store, repository) = makeStore()
        await store.load(userID: "u1")
        repository.delayFor["setTitleUpdatePreference"] = .milliseconds(60)

        async let first: Void = store.toggleFollow(titleID: "title-dune-2", userID: "u1")
        // Lascia partire la prima scrittura prima di simulare il secondo tap.
        try await Task.sleep(for: .milliseconds(10))
        try await store.toggleFollow(titleID: "title-dune-2", userID: "u1")
        try await first

        XCTAssertEqual(repository.recorder.count("setTitleUpdatePreference"), 1)
        XCTAssertTrue(store.isFollowing("title-dune-2"))
    }
}
