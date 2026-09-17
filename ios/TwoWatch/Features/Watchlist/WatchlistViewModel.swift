@preconcurrency import FirebaseStorage
import Observation
import SwiftUI

// Stato e logica della Watchlist, estratti da WatchlistView.swift.

@Observable
@MainActor
final class WatchlistViewModel {
    private let watchlistRepository: any WatchlistRepositoryProtocol
    private let titleRepository: any TitleRepositoryProtocol
    private let analytics: AnalyticsLogging
    /// Indice Spotlight. Opzionale perche' i test e le preview costruiscono il
    /// ViewModel senza: non indicizzare non cambia niente di cio' che si vede.
    private let spotlightIndexer: SpotlightIndexer?

    var dashboard: WatchlistDashboard = .empty
    var selectedArea: WatchlistArea = .home
    var selectedListDetail: UserListDetail?
    var editorMode: ListEditorMode?
    var draft = UserListEditorDraft()
    var draftSelectedTitles: [Title] = []
    var draftCollaborators: [AppUser] = []
    var titleSearchQuery = ""
    var titleSearchResults: [Title] = []
    var collaboratorQuery = ""
    var collaboratorResults: [AppUser] = []
    var naturalPreview: NaturalListPreview?
    var naturalSelection: Set<String> = []
    var pendingCoverImage: UIImage?
    var activeRatingContext: RatingSheetContext?
    var ratingPromptTitle: Title?
    var genreLookup: [String: String] = [:]
    var isLoading = false
    var isSavingList = false
    var isLoadingList = false
    var isSearchingTitles = false
    var isSearchingCollaborators = false
    var isPreparingNaturalPreview = false
    var isPreparingCover = false
    var pendingActionMessage: String?
    var successMessage: String?
    var errorMessage: String?
    /// Nomi piattaforma recuperati on-demand per titoli privi del campo denormalizzato
    /// (cache di sessione; un array vuoto significa "già provato, nessuna piattaforma").
    var watchProviderNamesByTitle: [String: [String]] = [:]
    /// Date di uscita future dei film della watchlist (titleId → data), caricate
    /// una volta per schermata e non per riga.
    var upcomingReleaseByTitle: [String: Date] = [:]
    /// Titoli già interrogati: senza questo, il caso normale ("nessuna uscita
    /// futura", cioè nessuna riga di risposta) verrebbe richiesto ad ogni passata.
    @ObservationIgnored private var upcomingReleaseCheckedTitleIDs: Set<String> = []
    /// Override ottimistico del pin per lista pubblica (listID -> nuovo stato),
    /// applicato subito al tap e rimosso solo dopo il reload che segue la
    /// risposta server (successo o rollback su errore). `UserListSummary`
    /// arriva da un `let` immutabile, quindi il flip visivo passa da qui invece
    /// che da una mutazione del modello.
    var pinOverrides: [String: Bool] = [:]
    /// ID lista con una toggle-pin in volo: disabilita il bottone e mostra uno
    /// spinner al posto dell'icona, per evitare tap ripetuti durante la latenza.
    var pinTogglesInFlight: Set<String> = []
    private var successMessageID = UUID()

    var isActionInFlight: Bool {
        pendingActionMessage != nil
    }

    private func performAction<T>(
        loadingMessage: String,
        operation: () async throws -> T
    ) async -> T? {
        guard pendingActionMessage == nil else { return nil }

        pendingActionMessage = loadingMessage
        successMessage = nil
        errorMessage = nil
        defer { pendingActionMessage = nil }

        do {
            let value = try await operation()
            showSuccessFeedback()
            return value
        } catch {
            errorMessage = friendlyFirestoreErrorMessage(error)
            return nil
        }
    }

    private func showSuccessFeedback() {
        let messageID = UUID()
        successMessageID = messageID
        successMessage = String(localized: "Fatto")

        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 1_800_000_000)
            guard successMessageID == messageID else { return }
            successMessage = nil
        }
    }

    /// Stato "salvata" effettivo da mostrare in UI: l'override ottimistico ha
    /// sempre precedenza sul valore del dashboard finché non arriva un reload.
    func isPublicListSaved(_ list: UserListSummary) -> Bool {
        pinOverrides[list.id] ?? list.isSavedByCurrentUser
    }

    var editableListsForQuickAdd: [UserListSummary] {
        let combined = dashboard.myLists + dashboard.sharedLists
        var seen: Set<String> = []
        return combined.filter { list in
            guard list.id != WatchlistRepository.generalWatchlistListID else { return false }
            guard list.canEdit else { return false }
            return seen.insert(list.id).inserted
        }
    }

    init(
        watchlistRepository: any WatchlistRepositoryProtocol,
        titleRepository: any TitleRepositoryProtocol,
        analytics: AnalyticsLogging = NoopAnalyticsLogger(),
        spotlightIndexer: SpotlightIndexer? = nil
    ) {
        self.watchlistRepository = watchlistRepository
        self.titleRepository = titleRepository
        self.analytics = analytics
        self.spotlightIndexer = spotlightIndexer
    }

    func load(userID: String) async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        do {
            async let dashboardTask = watchlistRepository.fetchWatchlistDashboard(userID: userID)
            async let genresTask = titleRepository.listGenres(limit: 400)

            dashboard = try await dashboardTask

            do {
                genreLookup = GenreDisplay.lookup(from: try await genresTask)
            } catch {
                SilentFailure.record(error, context: "Watchlist.genres")
            }

            // Dopo la tabella dei generi, non prima: e' quella che nella riga
            // di Spotlight trasforma `tmdb_27` in "Horror". Se non arriva,
            // `GenreDisplay` ha comunque la sua tabella di riserva.
            indexForSpotlight(userID: userID)
            updateWatchlistWidget()
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }

    func reload(userID: String) async {
        await load(userID: userID)
    }

    /// Allinea l'indice Spotlight al dashboard **appena caricato**.
    ///
    /// PERCHE' QUI — e' l'unico punto dell'app dove i titoli della watchlist
    /// sono gia' in memoria, idratati e per l'utente corrente: indicizzare
    /// altrove vorrebbe dire rileggere Firestore per un'informazione che
    /// abbiamo gia'.
    ///
    /// PERCHE' NON `await` — la scrittura legge le poster dalla cache su disco
    /// e, per le prime, le scarica. Aspettarla terrebbe acceso lo spinner della
    /// Watchlist per una funzione che non riguarda quella schermata, e per
    /// quanto dura una richiesta di rete. Non e' un caricamento
    /// legato al ciclo di vita di una View (§4.3): e' un effetto collaterale
    /// che parte una volta a caricamento riuscito.
    private func indexForSpotlight(userID: String) {
        guard let spotlightIndexer else { return }
        let snapshots = SpotlightTitleSnapshot.snapshots(from: dashboard, genreLookup: genreLookup)
        Task { await spotlightIndexer.index(snapshots: snapshots, userID: userID) }
    }

    /// Lascia al widget "Watchlist" il riassunto di cio' che l'utente sta
    /// guardando.
    ///
    /// PERCHE' QUI — stesso motivo di `indexForSpotlight`: e' l'unico punto in
    /// cui la watchlist e' gia' in memoria, idratata e dell'utente corrente. Un
    /// widget non puo' andarsela a prendere da solo (in un'estensione non c'e'
    /// sessione), quindi o gliela lascia chi ce l'ha, o non c'e'.
    ///
    /// PERCHE' NON `await` — e' una scrittura su file da poche centinaia di
    /// byte, ma resta un effetto collaterale che non riguarda questa schermata:
    /// aspettarla terrebbe acceso lo spinner della Watchlist per il widget.
    private func updateWatchlistWidget() {
        let snapshot = WatchlistWidgetSnapshotBuilder.snapshot(from: dashboard)
        Task.detached(priority: .utility) {
            WatchlistWidgetSnapshotStore.write(snapshot)
        }
    }

    /// Recupera i nomi piattaforma (flatrate/free/ads + custom admin) per i titoli della
    /// watchlist privi del campo denormalizzato `watchProviderNames`. Concorrenza limitata
    /// (max 6 fetch in volo) con cap totale per non saturare la callable; ogni risultato
    /// (anche vuoto) viene messo in cache. La logica per-titolo è identica alla versione
    /// sequenziale precedente; solo l'esecuzione è parallela.
    func enrichWatchProviders(for states: [TitlePersonalState]) async {
        let missing = states
            .filter { ($0.title?.watchProviderNames.isEmpty ?? true) && watchProviderNamesByTitle[$0.titleId] == nil }
            .prefix(24)
        guard !missing.isEmpty else { return }

        let subscriptionTypes: Set<String> = ["flatrate", "free", "ads"]
        let titleIDs = missing.map(\.titleId)
        let repository = titleRepository
        let maxConcurrent = 6

        // Calcolo per-titolo (immutato): fetch → filtra tipi subscription + custom → dedup.
        func resolve(_ titleID: String) async -> (String, [String]) {
            var providers: TitleProviders?
            do { providers = try await repository.fetchProviders(for: titleID, region: "IT") } catch { SilentFailure.record(error, context: "Watchlist.providers") }
            guard let providers else { return (titleID, []) }
            let sub = providers.providers.filter { subscriptionTypes.contains($0.type) }.map(\.name)
            let custom = providers.customProviders.map(\.name)
            var seen: Set<String> = []
            return (titleID, (sub + custom).filter { seen.insert($0).inserted })
        }

        await withTaskGroup(of: (String, [String]).self) { group in
            var iterator = titleIDs.makeIterator()
            // Seed iniziale (max `maxConcurrent` task in volo).
            var inFlight = 0
            while inFlight < maxConcurrent, let titleID = iterator.next() {
                group.addTask { await resolve(titleID) }
                inFlight += 1
            }
            // Man mano che un risultato arriva, scrivilo (sul MainActor) e avvia il prossimo.
            for await (titleID, names) in group {
                watchProviderNamesByTitle[titleID] = names
                if let next = iterator.next() {
                    group.addTask { await resolve(next) }
                }
            }
        }
    }

    /// Tetto agli id per passata: il filtro sull'anno lascia già pochi
    /// candidati, questo è solo un fermo contro le watchlist enormi. I titoli
    /// oltre il tetto entrano alla passata successiva, perché quelli già
    /// interrogati escono dai candidati.
    private static let upcomingReleaseLookupCap = 90

    /// Titoli da interrogare per l'uscita futura: solo film, e solo con un anno
    /// compatibile con un'uscita non ancora avvenuta.
    ///
    /// PERCHE' FILTRARE PER ANNO — `titles/{id}.year` viene dalla data di uscita
    /// TMDB: un film non ancora uscito non può avere un anno vecchio. L'anno di
    /// tolleranza copre il caso comune del film uscito altrove l'anno scorso e
    /// distribuito in Italia adesso. Senza il filtro, una watchlist da trecento
    /// film costerebbe dieci query per mostrare due badge.
    ///
    /// Anno assente = titolo senza data nota: si interroga, è proprio il caso
    /// di un film annunciato e non ancora datato.
    static func upcomingReleaseCandidateIDs(
        from states: [TitlePersonalState],
        referenceYear: Int,
        alreadyChecked: Set<String> = [],
        cap: Int = upcomingReleaseLookupCap
    ) -> [String] {
        // Niente `.lazy` qui: il filtro di dedup ha un effetto collaterale
        // (`seen.insert`) e una sequenza pigra viene percorsa piu' volte da
        // `Array(_:)`, che alla seconda passata scarterebbe tutto.
        var seen: Set<String> = []
        let candidates = states
            .filter { $0.mediaType == .movie }
            .filter { state in
                guard let year = state.title?.year else { return true }
                return year >= referenceYear - 1
            }
            .map(\.titleId)
            .filter { !$0.isEmpty && !alreadyChecked.contains($0) && seen.insert($0).inserted }
        return Array(candidates.prefix(cap))
    }

    /// Carica le date di uscita future per i film passati. Idempotente: un
    /// titolo già interrogato non torna in query anche se la schermata si
    /// ricostruisce.
    func loadUpcomingReleases(for states: [TitlePersonalState]) async {
        let referenceYear = Calendar.current.component(.year, from: Date())
        let candidates = Self.upcomingReleaseCandidateIDs(
            from: states,
            referenceYear: referenceYear,
            alreadyChecked: upcomingReleaseCheckedTitleIDs
        )
        guard !candidates.isEmpty else { return }

        do {
            let dates = try await titleRepository.fetchUpcomingReleaseDates(titleIDs: candidates)
            upcomingReleaseCheckedTitleIDs.formUnion(candidates)
            upcomingReleaseByTitle.merge(dates) { _, new in new }
        } catch {
            // Il badge è accessorio: la watchlist si vede lo stesso. Ma un
            // indice mancante deve arrivarci, non sparire in un `try?` (§5).
            SilentFailure.record(error, context: "Watchlist.upcomingReleases")
        }
    }

    /// Data di uscita futura del titolo, se ne ha una pubblicata.
    func upcomingReleaseDate(for state: TitlePersonalState) -> Date? {
        upcomingReleaseByTitle[state.titleId]
    }

    func openList(userID: String, listID: String) async {
        isLoadingList = true
        defer { isLoadingList = false }

        do {
            selectedListDetail = try await watchlistRepository.fetchListDetail(userID: userID, listID: listID)
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }

    /// Resolves a public-list deep-link slug (`/lista/{slug}`) to its list and
    /// opens the detail sheet. Returns `true` when the list was found.
    @discardableResult
    func openPublicList(slug: String, userID: String) async -> Bool {
        isLoadingList = true
        defer { isLoadingList = false }

        do {
            guard let summary = try await watchlistRepository.fetchPublicListBySlug(slug, currentUserID: userID) else {
                errorMessage = String(localized: "Lista non trovata o non più pubblica.")
                return false
            }
            selectedListDetail = try await watchlistRepository.fetchListDetail(userID: userID, listID: summary.id)
            return true
        } catch {
            errorMessage = UserFacingError.message(for: error)
            return false
        }
    }

    /// Toggle ottimistico: flippa subito `pinOverrides` (feedback immediato,
    /// anti tap-ripetuti via `pinTogglesInFlight`), poi chiama il server. Su
    /// successo ricarica la dashboard (l'override resta finché non arriva,
    /// così non c'è mai un frame con lo stato vecchio). Su errore riporta
    /// l'override al valore precedente.
    func togglePublicListPin(userID: String, list: UserListSummary) async {
        guard !pinTogglesInFlight.contains(list.id), pendingActionMessage == nil else { return }

        let previousOverride = pinOverrides[list.id]
        let newValue = !isPublicListSaved(list)
        pinOverrides[list.id] = newValue
        pinTogglesInFlight.insert(list.id)
        defer { pinTogglesInFlight.remove(list.id) }

        let result: Void? = await performAction(loadingMessage: String(localized: "Aggiorno lo stato…")) {
            try await watchlistRepository.togglePublicListPin(
                userID: userID,
                listID: list.id,
                isPinned: newValue
            )
            await reload(userID: userID)
            if selectedListDetail?.list.id == list.id {
                await openList(userID: userID, listID: list.id)
            }
            pinOverrides[list.id] = nil
        }
        if result == nil {
            pinOverrides[list.id] = previousOverride
        }
    }

    func setPublicListMovieSeen(
        userID: String,
        listID: String,
        item: UserListItem,
        isSeen: Bool
    ) async {
        guard let title = item.title else { return }
        _ = await performAction(loadingMessage: String(localized: "Aggiorno lo stato…")) {
            _ = try await watchlistRepository.setPublicListMovieSeen(
                userID: userID,
                listID: listID,
                title: title,
                isSeen: isSeen
            )
            await reload(userID: userID)
            if selectedListDetail?.list.id == listID {
                await openList(userID: userID, listID: listID)
            }
        }
    }

    @discardableResult
    func setPublicListSeriesProgress(
        userID: String,
        listID: String,
        item: UserListItem,
        watchedEpisodesCount: Int,
        completedSeasonsCount: Int,
        lastWatchedSeasonNumber: Int?,
        lastWatchedEpisodeNumber: Int?
    ) async -> PublicListItemProgress? {
        guard let title = item.title else { return nil }
        return await performAction(loadingMessage: String(localized: "Salvo il progresso…")) {
            let nextState = try await watchlistRepository.setPublicListSeriesProgress(
                userID: userID,
                listID: listID,
                title: title,
                watchedEpisodesCount: watchedEpisodesCount,
                completedSeasonsCount: completedSeasonsCount,
                lastWatchedSeasonNumber: lastWatchedSeasonNumber,
                lastWatchedEpisodeNumber: lastWatchedEpisodeNumber
            )
            await reload(userID: userID)
            if selectedListDetail?.list.id == listID {
                await openList(userID: userID, listID: listID)
            }
            return nextState
        }
    }

    func toggleGeneralWatchlist(userID: String, state: TitlePersonalState) async {
        guard let title = state.title else { return }
        _ = await performAction(loadingMessage: String(localized: "Aggiorno la Watchlist…")) {
            _ = try await watchlistRepository.updateGeneralWatchlist(
                userID: userID,
                title: title,
                isIncluded: !state.generalWatchlist
            )
            await reload(userID: userID)
            if let activeListID = selectedListDetail?.list.id {
                await openList(userID: userID, listID: activeListID)
            }
            clearRatingPrompt(for: title.id)
        }
    }

    func setRewatchIntent(userID: String, state: TitlePersonalState, isIncluded: Bool) async {
        guard let title = state.title else { return }
        _ = await performAction(loadingMessage: String(localized: "Aggiorno il Rewatch…")) {
            _ = try await watchlistRepository.updateRewatchIntent(
                userID: userID,
                title: title,
                isIncluded: isIncluded
            )
            await reload(userID: userID)
            if let activeListID = selectedListDetail?.list.id {
                await openList(userID: userID, listID: activeListID)
            }
            clearRatingPrompt(for: title.id)
        }
    }

    func addTitleToList(userID: String, listID: String, title: Title) async {
        _ = await performAction(loadingMessage: String(localized: "Salvataggio…")) {
            try await watchlistRepository.addTitleToList(userID: userID, listID: listID, title: title)
            analytics.log(AnalyticsEvent.watchlistItemAdded, [
                "title_id": title.id,
                "list_id": listID
            ])
            await reload(userID: userID)
            if let activeListID = selectedListDetail?.list.id {
                await openList(userID: userID, listID: activeListID)
            }
        }
    }

    func markSeen(userID: String, state: TitlePersonalState) async {
        guard let title = state.title else { return }
        let loadingMessage = title.type == .movie
            ? String(localized: "Salvo come visto…")
            : String(localized: "Salvo come completata…")
        guard let nextState = await performAction(
            loadingMessage: loadingMessage,
            operation: {
                let nextState: TitlePersonalState
                switch title.type {
                case .movie:
                    nextState = try await watchlistRepository.markMovieSeen(userID: userID, title: title)
                case .tv:
                    nextState = try await watchlistRepository.markSeriesCompleted(userID: userID, title: title)
                }
                await reload(userID: userID)
                if let activeListID = selectedListDetail?.list.id {
                    await openList(userID: userID, listID: activeListID)
                }
                return nextState
            }
        ) else { return }
        updateRatingPrompt(from: nextState, fallbackTitle: title)
    }

    @discardableResult
    func markSeriesEpisode(userID: String, state: TitlePersonalState) async -> TitlePersonalState? {
        guard let title = state.title else { return nil }
        return await performAction(loadingMessage: String(localized: "Salvo l'episodio…")) {
            let nextState = try await watchlistRepository.markSeriesEpisodeWatched(userID: userID, title: title)
            await reload(userID: userID)
            if let activeListID = selectedListDetail?.list.id {
                await openList(userID: userID, listID: activeListID)
            }
            return nextState
        }
    }

    /// Azioni rapide dal menu "tre puntini" delle card in una lista custom: operano
    /// direttamente sul `Title` (la card potrebbe non avere ancora un `personalState`
    /// per quel titolo). Dopo l'azione ricarichiamo e riapriamo la lista attiva così
    /// la griglia riflette il nuovo stato.
    @discardableResult
    func advanceSeriesEpisode(
        userID: String,
        title: Title
    ) async -> (previousEpisodeCount: Int, state: TitlePersonalState)? {
        guard title.type == .tv else { return nil }
        return await performAction(loadingMessage: String(localized: "Salvo l'episodio…")) {
            let previous = try await watchlistRepository.fetchTitleState(userID: userID, title: title)
            let nextState = try await watchlistRepository.markSeriesEpisodeWatched(userID: userID, title: title)
            await reload(userID: userID)
            if let activeListID = selectedListDetail?.list.id {
                await openList(userID: userID, listID: activeListID)
            }
            return (previous.seriesProgress?.episodesWatchedCount ?? 0, nextState)
        }
    }

    func markSeenFromList(userID: String, title: Title) async {
        let loadingMessage = title.type == .movie
            ? String(localized: "Salvo come visto…")
            : String(localized: "Salvo come completata…")
        _ = await performAction(
            loadingMessage: loadingMessage
        ) {
            switch title.type {
            case .movie:
                _ = try await watchlistRepository.markMovieSeen(userID: userID, title: title)
            case .tv:
                _ = try await watchlistRepository.markSeriesCompleted(userID: userID, title: title)
            }
            await reload(userID: userID)
            if let activeListID = selectedListDetail?.list.id {
                await openList(userID: userID, listID: activeListID)
            }
        }
    }

    func markSeriesSeason(userID: String, state: TitlePersonalState) async {
        guard let title = state.title else { return }
        _ = await performAction(loadingMessage: String(localized: "Salvo la stagione…")) {
            _ = try await watchlistRepository.markSeriesSeasonWatched(userID: userID, title: title)
            await reload(userID: userID)
            if let activeListID = selectedListDetail?.list.id {
                await openList(userID: userID, listID: activeListID)
            }
        }
    }

    func markSeriesCompleted(userID: String, state: TitlePersonalState) async {
        guard let title = state.title else { return }
        guard let nextState = await performAction(
            loadingMessage: String(localized: "Salvo come completata…"),
            operation: {
                let nextState = try await watchlistRepository.markSeriesCompleted(userID: userID, title: title)
                await reload(userID: userID)
                if let activeListID = selectedListDetail?.list.id {
                    await openList(userID: userID, listID: activeListID)
                }
                return nextState
            }
        ) else { return }
        updateRatingPrompt(from: nextState, fallbackTitle: title)
    }

    @discardableResult
    func setSeriesEpisodeProgress(
        userID: String,
        state: TitlePersonalState,
        watchedEpisodesCount: Int,
        completedSeasonsCount: Int,
        lastWatchedSeasonNumber: Int?,
        lastWatchedEpisodeNumber: Int?
    ) async -> TitlePersonalState? {
        guard let title = state.title else { return nil }
        guard let nextState = await performAction(
            loadingMessage: String(localized: "Salvo il progresso…"),
            operation: {
                let nextState = try await watchlistRepository.setSeriesProgress(
                    userID: userID,
                    title: title,
                    watchedEpisodesCount: watchedEpisodesCount,
                    completedSeasonsCount: completedSeasonsCount,
                    lastWatchedSeasonNumber: lastWatchedSeasonNumber,
                    lastWatchedEpisodeNumber: lastWatchedEpisodeNumber,
                    source: "series_episode_adjust"
                )
                await reload(userID: userID)
                if let activeListID = selectedListDetail?.list.id {
                    await openList(userID: userID, listID: activeListID)
                }
                return nextState
            }
        ) else { return nil }
        updateRatingPrompt(from: nextState, fallbackTitle: title)
        return nextState
    }

    func setSeriesSeasonProgress(
        userID: String,
        state: TitlePersonalState,
        watchedEpisodesCount: Int,
        completedSeasonsCount: Int,
        lastWatchedSeasonNumber: Int?,
        lastWatchedEpisodeNumber: Int?
    ) async {
        guard let title = state.title else { return }
        guard let nextState = await performAction(
            loadingMessage: String(localized: "Salvo il progresso…"),
            operation: {
                let nextState = try await watchlistRepository.setSeriesProgress(
                    userID: userID,
                    title: title,
                    watchedEpisodesCount: watchedEpisodesCount,
                    completedSeasonsCount: completedSeasonsCount,
                    lastWatchedSeasonNumber: lastWatchedSeasonNumber,
                    lastWatchedEpisodeNumber: lastWatchedEpisodeNumber,
                    source: "series_season_adjust"
                )
                await reload(userID: userID)
                if let activeListID = selectedListDetail?.list.id {
                    await openList(userID: userID, listID: activeListID)
                }
                return nextState
            }
        ) else { return }
        updateRatingPrompt(from: nextState, fallbackTitle: title)
    }

    func deferRating(userID: String, title: Title) async {
        _ = await performAction(loadingMessage: String(localized: "Salvo per dopo…")) {
            _ = try await watchlistRepository.markRatingDeferred(userID: userID, title: title)
            await reload(userID: userID)
        }
    }

    func submitRating(userID: String, title: Title, value: Double) async {
        _ = await performAction(loadingMessage: String(localized: "Salvo il voto…")) {
            try await titleRepository.submitRating(
                userID: userID,
                titleID: title.id,
                level: "title",
                season: nil,
                episode: nil,
                value: value,
                reviewText: nil
            )
            _ = try await watchlistRepository.syncPersonalStateAfterRating(userID: userID, title: title, ratingValue: value)
            activeRatingContext = nil
            clearRatingPrompt(for: title.id)
            await reload(userID: userID)
            if let activeListID = selectedListDetail?.list.id {
                await openList(userID: userID, listID: activeListID)
            }
        }
    }

    func openRatingPrompt(for title: Title) {
        ratingPromptTitle = nil
        activeRatingContext = RatingSheetContext(title: title)
    }

    func dismissRatingPrompt() {
        ratingPromptTitle = nil
    }

    func prepareCreateList(seedTitle: Title? = nil, preset: WatchlistListPreset? = nil) {
        editorMode = .create
        draft = UserListEditorDraft(
            title: preset?.title ?? "",
            visibility: preset?.visibility ?? .private,
            kind: preset?.kind ?? .collection,
            selectedTitleIDs: seedTitle.map { [$0.id] } ?? []
        )
        draftSelectedTitles = seedTitle.map { [$0] } ?? []
        draftCollaborators = []
        titleSearchQuery = ""
        titleSearchResults = []
        collaboratorQuery = ""
        collaboratorResults = []
        naturalPreview = nil
        naturalSelection = []
        pendingCoverImage = nil
    }

    func prepareEditList(_ detail: UserListDetail) {
        editorMode = .edit(detail)
        draft = UserListEditorDraft(
            title: detail.list.title,
            description: detail.list.description ?? "",
            visibility: detail.list.visibility,
            kind: detail.list.kind,
            coverImageURL: detail.list.cover.imageURL,
            coverStoragePath: detail.list.cover.storagePath,
            collaboratorIDs: detail.members.filter(\.canEdit).map(\.id).filter { $0 != detail.list.ownerUid },
            selectedTitleIDs: detail.items.map(\.titleId),
            naturalPrompt: ""
        )
        draftSelectedTitles = detail.items.compactMap(\.title)
        draftCollaborators = detail.members
            .filter(\.canEdit)
            .filter { $0.id != detail.list.ownerUid }
            .map { member in
                AppUser(
                    id: member.id,
                    displayName: member.displayName,
                    displayNameLower: SearchNormalizer.normalize(member.displayName),
                    photoURL: member.photoURL,
                    avatarURL: member.photoURL,
                    trusted: false,
                    isAdmin: false,
                    level: .base,
                    stats: UserStats(ratingsCount: 0, reviewsCount: 0, watchedCount: 0, totalWatchMinutes: 0),
                    favoriteGenres: [],
                    communitySafetyAcceptedAt: nil,
                    communitySafetyVersion: 0
                )
            }
        titleSearchQuery = ""
        titleSearchResults = []
        collaboratorQuery = ""
        collaboratorResults = []
        naturalPreview = nil
        naturalSelection = []
        pendingCoverImage = nil
    }

    /// Ritorna `true` solo se il salvataggio è andato a buon fine.
    /// Il guard su `isSavingList` è sincrono (MainActor) rispetto al set: tap
    /// ravvicinati non possono avviare più salvataggi in parallelo.
    func saveList(userID: String, owner: AppUser?) async -> Bool {
        guard !isSavingList else { return false }
        isSavingList = true
        defer { isSavingList = false }

        do {
            let detail: UserListDetail
            switch editorMode {
            case .create:
                detail = try await watchlistRepository.createList(
                    userID: userID,
                    owner: owner,
                    draft: currentDraft,
                    collaborators: draftCollaborators
                )
            case let .edit(existing):
                detail = try await watchlistRepository.updateList(
                    userID: userID,
                    listID: existing.list.id,
                    draft: currentDraft,
                    collaborators: draftCollaborators
                )
            case .none:
                return false
            }

            if let pendingCoverImage {
                _ = try await watchlistRepository.uploadListCover(userID: userID, listID: detail.list.id, image: pendingCoverImage)
            }

            selectedListDetail = try await watchlistRepository.fetchListDetail(userID: userID, listID: detail.list.id)
            editorMode = nil
            await reload(userID: userID)
            showSuccessFeedback()
            return true
        } catch {
            errorMessage = UserFacingError.message(for: error)
            return false
        }
    }

    func deleteSelectedList(userID: String) async {
        guard let detail = selectedListDetail else { return }
        _ = await performAction(loadingMessage: String(localized: "Salvataggio…")) {
            try await watchlistRepository.deleteList(userID: userID, listID: detail.list.id)
            selectedListDetail = nil
            await reload(userID: userID)
        }
    }

    func duplicateSelectedList(userID: String, owner: AppUser?) async {
        guard let detail = selectedListDetail else { return }
        _ = await performAction(loadingMessage: String(localized: "Salvataggio…")) {
            selectedListDetail = try await watchlistRepository.duplicateList(
                userID: userID,
                sourceListID: detail.list.id,
                owner: owner
            )
            await reload(userID: userID)
        }
    }

    func searchTitlesForDraft() async {
        let trimmed = titleSearchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            titleSearchResults = []
            return
        }
        guard !isSearchingTitles else { return }
        isSearchingTitles = true
        defer { isSearchingTitles = false }

        do {
            titleSearchResults = try await titleRepository.searchTitlesForListBuilder(trimmed, limit: 20)
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }

    func searchCollaborators(userID: String) async {
        let trimmed = collaboratorQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            collaboratorResults = []
            return
        }
        guard !isSearchingCollaborators else { return }
        isSearchingCollaborators = true
        defer { isSearchingCollaborators = false }

        do {
            collaboratorResults = try await watchlistRepository.searchCollaborators(
                query: trimmed,
                userID: userID,
                excluding: draftCollaborators.map(\.id)
            )
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }

    func generateNaturalPreview() async {
        let trimmed = draft.naturalPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            naturalPreview = nil
            naturalSelection = []
            return
        }
        guard !isPreparingNaturalPreview else { return }
        isPreparingNaturalPreview = true
        defer { isPreparingNaturalPreview = false }

        do {
            let preview = try await watchlistRepository.buildNaturalListPreview(trimmed)
            naturalPreview = preview
            naturalSelection = Set(preview.candidates.map(\.id))
            if draft.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                draft.title = preview.suggestedName
            }
            if draft.description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                draft.description = preview.suggestedDescription ?? ""
            }
            draft.kind = preview.suggestedKind
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }

    func applyNaturalPreviewSelection() {
        guard let naturalPreview else { return }

        for candidate in naturalPreview.candidates where naturalSelection.contains(candidate.id) {
            toggleDraftTitle(candidate.title, isSelected: true)
        }
    }

    func toggleDraftTitle(_ title: Title, isSelected: Bool) {
        if isSelected {
            guard !draftSelectedTitles.contains(where: { $0.id == title.id }) else { return }
            draftSelectedTitles.append(title)
        } else {
            draftSelectedTitles.removeAll { $0.id == title.id }
        }
    }

    func toggleCollaborator(_ user: AppUser) {
        if draftCollaborators.contains(where: { $0.id == user.id }) {
            draftCollaborators.removeAll { $0.id == user.id }
        } else {
            draftCollaborators.append(user)
        }
    }

    func removeDraftTitle(_ titleID: String) {
        draftSelectedTitles.removeAll { $0.id == titleID }
    }

    func moveDraftTitles(from offsets: IndexSet, to destination: Int) {
        draftSelectedTitles.move(fromOffsets: offsets, toOffset: destination)
    }

    func moveSelectedListItems(userID: String, from offsets: IndexSet, to destination: Int) async {
        guard var detail = selectedListDetail else { return }
        var reordered = detail.items
        reordered.move(fromOffsets: offsets, toOffset: destination)

        _ = await performAction(loadingMessage: String(localized: "Salvataggio…")) {
            try await watchlistRepository.reorderListItems(
                userID: userID,
                listID: detail.list.id,
                itemIDs: reordered.map(\.titleId)
            )
            detail = try await watchlistRepository.fetchListDetail(userID: userID, listID: detail.list.id)
            selectedListDetail = detail
            await reload(userID: userID)
        }
    }

    func removeSelectedListItem(userID: String, titleID: String) async {
        guard let detail = selectedListDetail else { return }
        _ = await performAction(loadingMessage: String(localized: "Salvataggio…")) {
            try await watchlistRepository.removeTitleFromList(userID: userID, listID: detail.list.id, titleID: titleID)
            selectedListDetail = try await watchlistRepository.fetchListDetail(userID: userID, listID: detail.list.id)
            await reload(userID: userID)
        }
    }

    private func updateRatingPrompt(from state: TitlePersonalState, fallbackTitle: Title) {
        if state.isAwaitingRating {
            ratingPromptTitle = state.title ?? fallbackTitle
        } else {
            clearRatingPrompt(for: fallbackTitle.id)
        }
    }

    private func clearRatingPrompt(for titleID: String) {
        if ratingPromptTitle?.id == titleID {
            ratingPromptTitle = nil
        }
    }

    private var currentDraft: UserListEditorDraft {
        UserListEditorDraft(
            title: draft.title,
            description: draft.description,
            visibility: draft.visibility,
            kind: draft.kind,
            coverImageURL: draft.coverImageURL,
            coverStoragePath: draft.coverStoragePath,
            collaboratorIDs: draftCollaborators.map(\.id),
            selectedTitleIDs: draftSelectedTitles.map(\.id),
            naturalPrompt: draft.naturalPrompt
        )
    }
}
