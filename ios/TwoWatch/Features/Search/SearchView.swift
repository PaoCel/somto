import Observation
import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

enum SearchScope: String, CaseIterable, Identifiable {
    case titles = "Titoli"
    case users = "Utenti"
    case genres = "Generi"
    case people = "Persone"

    var id: String { rawValue }

    var systemImage: String {
        switch self {
        case .titles: return "film.stack.fill"
        case .users: return "person.2.fill"
        case .genres: return "rectangle.stack.fill"
        case .people: return "person.text.rectangle.fill"
        }
    }

    var historyKey: String {
        switch self {
        case .titles: return "titles"
        case .users: return "users"
        case .genres: return "genres"
        case .people: return "people"
        }
    }

    /// Static suggestions shown when the query is empty. Localized into Italian
    /// to match the rest of the UI copy.
    var suggestions: [String] {
        switch self {
        case .titles: return ["Marvel", "Pixar", "Christopher Nolan", "Dune", "Stranger Things"]
        case .users: return []
        case .genres: return ["Azione", "Commedia", "Documentari", "Thriller"]
        case .people: return ["Margot Robbie", "Denis Villeneuve", "Zendaya", "Cillian Murphy"]
        }
    }
}

/// Lightweight persistence for the user's recent search queries. Each scope
/// has its own list capped to a small number of entries so the suggestion
/// strip stays readable.
@MainActor
final class SearchHistoryStore {
    private let defaults: UserDefaults
    private let limit = 8
    private let prefix = SomtoDefaultsKey.searchHistoryPrefix

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func recent(for scope: SearchScope) -> [String] {
        defaults.stringArray(forKey: prefix + scope.historyKey) ?? []
    }

    func record(_ query: String, for scope: SearchScope) {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        var current = recent(for: scope)
        current.removeAll { $0.caseInsensitiveCompare(trimmed) == .orderedSame }
        current.insert(trimmed, at: 0)
        if current.count > limit { current = Array(current.prefix(limit)) }
        defaults.set(current, forKey: prefix + scope.historyKey)
    }

    func remove(_ query: String, for scope: SearchScope) {
        var current = recent(for: scope)
        current.removeAll { $0.caseInsensitiveCompare(query) == .orderedSame }
        defaults.set(current, forKey: prefix + scope.historyKey)
    }

    func clear(_ scope: SearchScope) {
        defaults.removeObject(forKey: prefix + scope.historyKey)
    }
}

enum SearchActivityState: Equatable {
    case idle
    case debouncing
    case searchingCatalog
    case searchingRemote
    case generic
}

/// Client-side type filter applied to already-fetched results. Mirrors the
/// web equivalent (`search.page.js`), which filters titles/genres/people by
/// media type without an extra Firestore round-trip.
enum SearchTypeFilter: String, CaseIterable, Identifiable {
    case all
    case movie
    case tv

    var id: String { rawValue }

    var label: String {
        switch self {
        case .all: return "Tutti"
        // Filtro di categoria: in inglese va al plurale ("Movies"), a
        // differenza del chip su un singolo titolo ("Movie"). Stessa
        // parola in italiano, due chiavi diverse.
        case .movie: return String(localized: "category.movies", defaultValue: "Film")
        case .tv: return String(localized: "category.series", defaultValue: "Serie")
        }
    }

    var mediaType: MediaType? {
        switch self {
        case .all: return nil
        case .movie: return .movie
        case .tv: return .tv
        }
    }

    func matches(_ type: MediaType) -> Bool {
        guard let mediaType else { return true }
        return mediaType == type
    }
}

@Observable
@MainActor
final class SearchViewModel {
    private let titleRepository: TitleRepository
    private let userRepository: UserRepository
    @ObservationIgnored private var searchTask: Task<Void, Never>?
    @ObservationIgnored private var latestSearchToken = UUID()
    /// Guards genre/person detail fetches (`titlesForGenre`/`titlesForPerson`)
    /// against races when the user backs out and opens another genre/person
    /// before the previous fetch resolves. Mirrors the pattern already used
    /// by `runSearch(canSearchUsers:token:)`.
    @ObservationIgnored private var latestDetailToken = UUID()

    var query = ""
    var scope: SearchScope = .titles
    var typeFilter: SearchTypeFilter = .all
    var titles: [Title] = []
    var tmdbResults: [TMDBSearchResult] = []
    var users: [AppUser] = []
    var genres: [Genre] = []
    var people: [Person] = []
    var isLoading = false
    var errorMessage: String?
    var resolvingIDs: Set<String> = []
    var addingToWatchlistIDs: Set<String> = []
    var addedToWatchlistIDs: Set<String> = []
    var searchActivity: SearchActivityState = .idle
    var completedTitleQuery = ""
    /// Sequence number that bumps every time the persisted history is mutated,
    /// so SwiftUI views that depend on the recent strip can react. Reading the
    /// raw `UserDefaults` array on every body invocation would be cheap but
    /// would not trigger redraws without an observable signal.
    var historyRevision = 0

    private let history = SearchHistoryStore()

    init(titleRepository: TitleRepository, userRepository: UserRepository) {
        self.titleRepository = titleRepository
        self.userRepository = userRepository
    }

    func recentQueries(for scope: SearchScope) -> [String] {
        _ = historyRevision
        return history.recent(for: scope)
    }

    func applyRecent(_ query: String) {
        self.query = query
    }

    func removeRecent(_ query: String, scope: SearchScope) {
        history.remove(query, for: scope)
        historyRevision &+= 1
    }

    func clearRecent(for scope: SearchScope) {
        history.clear(scope)
        historyRevision &+= 1
    }

    /// Records the query in the per-scope history. Called after a search
    /// completes successfully so we only persist things the user actually
    /// looked at results for.
    fileprivate func recordHistory(_ query: String, for scope: SearchScope) {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 2 else { return }
        history.record(trimmed, for: scope)
        historyRevision &+= 1
    }

    /// Result counts per scope, used as a small badge in the segmented picker.
    /// Returns nil when there is nothing meaningful to display (idle / first
    /// load) to avoid a flickering "0" while debouncing.
    func resultCount(for scope: SearchScope) -> Int? {
        let normalizedQuery = SearchNormalizer.normalize(query)
        guard !normalizedQuery.isEmpty else { return nil }

        switch scope {
        case .titles:
            guard hasCompletedTitleSearch else { return nil }
            return filteredTitles.count + filteredTmdbResults.count
        case .users:
            guard searchActivity == .idle, !isLoading else { return nil }
            return users.count
        case .genres:
            let filtered = genres.filter { $0.nameLower.contains(normalizedQuery) }
            return filtered.count
        case .people:
            guard searchActivity == .idle, !isLoading else { return nil }
            return people.count
        }
    }

    /// Titles filtered client-side by the current Film/Serie chip. No extra
    /// Firestore round-trip: the repository already returned the full result
    /// set within its limit, we just narrow it down for display.
    var filteredTitles: [Title] {
        guard let mediaType = typeFilter.mediaType else { return titles }
        return titles.filter { $0.type == mediaType }
    }

    var filteredTmdbResults: [TMDBSearchResult] {
        guard let mediaType = typeFilter.mediaType else { return tmdbResults }
        return tmdbResults.filter { $0.mediaType == mediaType }
    }

    func bootstrap() async {
        if genres.isEmpty {
            do {
                genres = try await titleRepository.listGenres(limit: 300)
            } catch {
                errorMessage = UserFacingError.message(for: error)
            }
        }
    }

    func scheduleSearch(canSearchUsers: Bool) {
        searchTask?.cancel()
        let token = UUID()
        latestSearchToken = token
        let normalizedQuery = SearchNormalizer.normalize(query)
        errorMessage = nil

        guard !normalizedQuery.isEmpty else {
            isLoading = false
            searchActivity = .idle
            completedTitleQuery = ""
            clearResultsForCurrentScope()
            return
        }

        if scope == .genres, !genres.isEmpty {
            isLoading = false
            searchActivity = .idle
            return
        }

        // limit: 60 deve combaciare con quello usato in `runSearch`, altrimenti
        // la cache-key ("query#60" vs "query#20") non farebbe mai hit.
        if scope == .titles, let cached = titleRepository.cachedCatalogSearchResults(query, limit: 60) {
            titles = cached.titles
            tmdbResults = cached.tmdbResults
            completedTitleQuery = normalizedQuery
            isLoading = false
            searchActivity = .idle
            recordHistory(query, for: .titles)
            return
        }

        prepareResultsForSearch()
        searchTask = Task { [weak self] in
            let debounce: UInt64 = self?.scope == .titles ? 250_000_000 : 300_000_000
            try? await Task.sleep(nanoseconds: debounce)
            guard !Task.isCancelled else { return }
            await self?.runSearch(canSearchUsers: canSearchUsers, token: token)
        }
    }

    func openTMDB(_ item: TMDBSearchResult, currentUser: AppUser?) async throws -> Title {
        resolvingIDs.insert(item.id)
        defer { resolvingIDs.remove(item.id) }
        return try await titleRepository.resolveTMDBSearchResult(
            item,
            localCandidates: titles,
            currentUser: currentUser
        )
    }

    func titlesForGenre(_ genre: Genre, type: MediaType? = nil) async throws -> [Title] {
        try await titleRepository.titlesForGenre(genre.id, type: type)
    }

    func titlesForPerson(_ person: Person, type: MediaType? = nil, role: String = "all") async throws -> [Title] {
        try await titleRepository.titlesForPerson(person.id, type: type, role: role)
    }

    /// Adds a title to the "da vedere" watchlist from a search result card.
    /// Requires an authenticated user (checked by the caller before invoking
    /// this); surfaces failures via `errorMessage` like the rest of the
    /// screen instead of failing silently.
    func quickAddToWatchlist(
        titleID: String,
        userID: String,
        watchlistRepository: WatchlistRepository
    ) async {
        guard !addingToWatchlistIDs.contains(titleID) else { return }
        addingToWatchlistIDs.insert(titleID)
        defer { addingToWatchlistIDs.remove(titleID) }

        do {
            let isNowIncluded = try await watchlistRepository.toggleWatchlist(
                userID: userID,
                titleID: titleID,
                source: "ios_search"
            )
            if isNowIncluded {
                addedToWatchlistIDs.insert(titleID)
            } else {
                addedToWatchlistIDs.remove(titleID)
            }
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }

    var shouldShowSearchActivity: Bool {
        let normalizedQuery = SearchNormalizer.normalize(query)
        guard !normalizedQuery.isEmpty else { return false }

        switch scope {
        case .titles:
            return searchActivity != .idle
        default:
            return isLoading
        }
    }

    var searchActivityTitle: String? {
        guard shouldShowSearchActivity else { return nil }

        switch scope {
        case .titles:
            switch searchActivity {
            case .debouncing:
                return "Preparo la ricerca"
            case .searchingCatalog:
                return "Cerco nel catalogo Somto"
            case .searchingRemote:
                return titles.isEmpty
                    ? "Controllo anche TMDB"
                    : "Ti mostro Somto mentre completo TMDB"
            case .generic:
                return "Sto cercando"
            case .idle:
                return nil
            }
        case .users:
            return "Sto cercando profili"
        case .genres:
            return "Carico i generi"
        case .people:
            return "Sto cercando persone"
        }
    }

    var searchActivityMessage: String? {
        guard shouldShowSearchActivity else { return nil }

        switch scope {
        case .titles:
            switch searchActivity {
            case .debouncing:
                return "Aspetto un istante per evitare richieste inutili mentre stai ancora scrivendo."
            case .searchingCatalog:
                return "Prima recupero i match già presenti in app, così i risultati utili compaiono subito."
            case .searchingRemote:
                return titles.isEmpty
                    ? "Il catalogo locale non basta: sto interrogando TMDB per proporti anche titoli non ancora importati."
                    : "I risultati locali sono già pronti. Ora sto cercando nuovi titoli remoti senza bloccare la schermata."
            case .generic:
                return "Aggiorno i risultati per la query corrente."
            case .idle:
                return nil
            }
        case .users:
            return "Filtro i profili leggibili per il testo inserito."
        case .genres:
            return "Recupero la lista completa così poi il filtro resta immediato."
        case .people:
            return "Cerco actor e director nella collection people."
        }
    }

    var isSearchingTMDB: Bool {
        scope == .titles && searchActivity == .searchingRemote
    }

    var hasCompletedTitleSearch: Bool {
        let normalizedQuery = SearchNormalizer.normalize(query)
        return scope == .titles &&
            !normalizedQuery.isEmpty &&
            completedTitleQuery == normalizedQuery &&
            searchActivity == .idle
    }

    var shouldShowEmptyTitleState: Bool {
        hasCompletedTitleSearch && titles.isEmpty && tmdbResults.isEmpty
    }

    /// True when the type filter (Film/Serie) hid every fetched result even
    /// though the underlying search did return something. Distinct from
    /// `shouldShowEmptyTitleState` so we can offer "Mostra tutti i tipi"
    /// instead of the generic no-results copy.
    var shouldShowFilteredOutState: Bool {
        hasCompletedTitleSearch &&
            typeFilter != .all &&
            (!titles.isEmpty || !tmdbResults.isEmpty) &&
            filteredTitles.isEmpty &&
            filteredTmdbResults.isEmpty
    }

    private func runSearch(canSearchUsers: Bool, token: UUID) async {
        let normalizedQuery = SearchNormalizer.normalize(query)
        guard !normalizedQuery.isEmpty else {
            if token == latestSearchToken {
                isLoading = false
                searchActivity = .idle
                completedTitleQuery = ""
                clearResultsForCurrentScope()
            }
            return
        }

        errorMessage = nil
        isLoading = true

        do {
            switch scope {
            case .titles:
                searchActivity = .searchingCatalog
                // Allineato al fallback web (60 locali / 20 TMDB): con soli 20
                // risultati locali il filtro Film/Serie lato client svuotava
                // spesso una delle due colonne (es. "marvel" mostrava 3 serie
                // su 20 match totali). Alzare il limit qui non richiede una
                // nuova query Firestore: `searchTitles` accetta già `limit`.
                let localTitles = try await titleRepository.searchTitles(query, limit: 60)
                guard token == latestSearchToken else { return }
                titles = localTitles
                tmdbResults = []

                let shouldSearchTMDB = normalizedQuery.count >= 2
                let tmdbLimit = 20

                if shouldSearchTMDB {
                    searchActivity = .searchingRemote
                    let remoteTitles = (try? await titleRepository.searchTMDBCached(query, limit: tmdbLimit)) ?? []
                    guard token == latestSearchToken else { return }

                    let results = titleRepository.mergeCatalogSearchResults(
                        localTitles: localTitles,
                        remoteResults: remoteTitles
                    )
                    titles = results.titles
                    tmdbResults = results.tmdbResults
                    titleRepository.cacheCatalogSearchResults(results, query: query)
                } else {
                    let results = TitleSearchResults(titles: localTitles, tmdbResults: [])
                    titleRepository.cacheCatalogSearchResults(results, query: query)
                }

                completedTitleQuery = normalizedQuery
                searchActivity = .idle
            case .users:
                searchActivity = .generic
                let nextUsers = canSearchUsers && !normalizedQuery.isEmpty
                    ? try await userRepository.searchUsers(prefix: query)
                    : []
                guard token == latestSearchToken else { return }
                users = nextUsers
            case .genres:
                searchActivity = .generic
                if genres.isEmpty {
                    let nextGenres = try await titleRepository.listGenres(limit: 300)
                    guard token == latestSearchToken else { return }
                    genres = nextGenres
                }
            case .people:
                searchActivity = .generic
                let nextPeople = normalizedQuery.isEmpty ? [] : try await titleRepository.searchPeople(query)
                guard token == latestSearchToken else { return }
                people = nextPeople
            }
        } catch {
            guard token == latestSearchToken else { return }
            errorMessage = UserFacingError.message(for: error)
            searchActivity = .idle
        }

        if token == latestSearchToken {
            isLoading = false
            if scope != .titles {
                searchActivity = .idle
            }
            // Record the query in history once a search round-trip succeeded.
            // For genres we record on the typed query even though filtering is
            // local, because the user did intentionally search for that term.
            recordHistory(query, for: scope)
        }
    }

    private func prepareResultsForSearch() {
        isLoading = true
        searchActivity = .debouncing

        switch scope {
        case .titles:
            completedTitleQuery = ""
            titles = []
            tmdbResults = []
        case .users:
            users = []
        case .genres:
            break
        case .people:
            people = []
        }
    }

    private func clearResultsForCurrentScope() {
        switch scope {
        case .titles:
            titles = []
            tmdbResults = []
        case .users:
            users = []
        case .genres:
            break
        case .people:
            people = []
        }
    }
}

struct SearchView: View {
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore
    private let disablesAutomaticLoading: Bool
    @State private var viewModel: SearchViewModel
    @State private var importedTitle: Title?

    init(container: AppContainer, session: SessionStore, shell: AppShellStore) {
        self.container = container
        self.session = session
        self.shell = shell
        disablesAutomaticLoading = false
        _viewModel = State(initialValue: SearchViewModel(
            titleRepository: container.titleRepository,
            userRepository: container.userRepository
        ))
    }

#if DEBUG
    init(container: AppContainer, session: SessionStore, shell: AppShellStore, previewViewModel: SearchViewModel) {
        self.container = container
        self.session = session
        self.shell = shell
        disablesAutomaticLoading = true
        _viewModel = State(initialValue: previewViewModel)
    }
#endif

    var body: some View {
        @Bindable var viewModel = viewModel

        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                scopePicker

                if let errorMessage = viewModel.errorMessage {
                    GlassCard {
                        Text(errorMessage)
                            .foregroundStyle(Color.red)
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel(Text("Errore"))
                    .accessibilityValue(Text(errorMessage))
                }

                content
            }
            .padding(.horizontal, 20)
            .padding(.top, 20)
            .padding(.bottom, 36)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(TwoWatchBackground())
        .searchable(text: $viewModel.query, prompt: searchPrompt)
        .navigationTitle("Cerca")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button("Chiudi") {
                    shell.isSearchPresented = false
                }
                .foregroundStyle(TwoWatchTheme.textPrimary)
                .accessibilityHint(Text("Chiude la ricerca"))
            }
        }
        .task {
            guard !disablesAutomaticLoading else { return }
            await viewModel.bootstrap()
            viewModel.scheduleSearch(canSearchUsers: session.permissions.canSearchUsers)
        }
        .onChange(of: viewModel.query) { _, _ in
            guard !disablesAutomaticLoading else { return }
            viewModel.scheduleSearch(canSearchUsers: session.permissions.canSearchUsers)
        }
        .onChange(of: viewModel.scope) { _, _ in
            guard !disablesAutomaticLoading else { return }
            viewModel.scheduleSearch(canSearchUsers: session.permissions.canSearchUsers)
        }
        .navigationDestination(item: $importedTitle) { title in
            TitleDetailView(container: container, session: session, shell: shell, titleID: title.id)
        }
    }

    private var searchPrompt: LocalizedStringKey {
        switch viewModel.scope {
        case .titles: return "Cerca un film, una serie…"
        case .users: return "Cerca un nome utente"
        case .genres: return "Filtra per genere"
        case .people: return "Cerca attori, registi…"
        }
    }

    private var scopePicker: some View {
        @Bindable var viewModel = viewModel
        return Picker("Tipo di ricerca", selection: $viewModel.scope) {
            ForEach(SearchScope.allCases) { scope in
                Text(scopeLabel(for: scope)).tag(scope)
            }
        }
        .pickerStyle(.segmented)
        .accessibilityIdentifier("search-scope-picker")
        .accessibilityHint(Text("Cambia il tipo di risultati mostrati"))
    }

    /// Adds the result count next to the scope name when available so users get
    /// at-a-glance feedback that switching tab will yield more or fewer results.
    private func scopeLabel(for scope: SearchScope) -> String {
        guard let count = viewModel.resultCount(for: scope), count > 0 else {
            return scope.rawValue
        }
        return "\(scope.rawValue) \(count)"
    }

    private func dismissKeyboard() {
#if canImport(UIKit)
        UIApplication.shared.sendAction(
            #selector(UIResponder.resignFirstResponder),
            to: nil,
            from: nil,
            for: nil
        )
#endif
    }

    @ViewBuilder
    private var content: some View {
        switch viewModel.scope {
        case .titles:
            titlesContent
        case .users:
            usersContent
        case .genres:
            genresContent
        case .people:
            peopleContent
        }
    }

    private let titleGridColumns = [
        GridItem(.flexible(), spacing: 14),
        GridItem(.flexible(), spacing: 14),
        GridItem(.flexible(), spacing: 14)
    ]

    private var titlesContent: some View {
        VStack(alignment: .leading, spacing: 16) {
            if viewModel.query.isEmpty {
                idleSuggestions(for: .titles, helperMessage: "Digita un titolo o tocca un suggerimento per iniziare.")
            } else {
                typeFilterChips

                if let title = viewModel.searchActivityTitle {
                    SearchActivityCard(
                        title: title,
                        message: viewModel.searchActivityMessage
                    )
                }

                // Il catalogo locale non è ancora arrivato: niente schermo
                // "silenzioso", mostriamo subito uno skeleton poster così
                // l'utente capisce che la ricerca è in corso.
                if viewModel.isLoading, viewModel.titles.isEmpty, viewModel.tmdbResults.isEmpty {
                    titleGridSkeleton
                } else if viewModel.shouldShowEmptyTitleState {
                    noResultsState
                } else if viewModel.shouldShowFilteredOutState {
                    filteredOutState
                } else {
                    LazyVGrid(columns: titleGridColumns, spacing: 14) {
                        ForEach(viewModel.filteredTitles) { title in
                            titleResultCell(title)
                        }

                        ForEach(viewModel.filteredTmdbResults) { item in
                            Button {
                                dismissKeyboard()
                                Task {
                                    do {
                                        importedTitle = try await viewModel.openTMDB(item, currentUser: session.appUser)
                                    } catch {
                                        viewModel.errorMessage = UserFacingError.message(for: error)
                                    }
                                }
                            } label: {
                                SearchTMDBGridCell(
                                    item: item,
                                    isResolving: viewModel.resolvingIDs.contains(item.id)
                                )
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(Text("\(item.title), da TMDB"))
                            .accessibilityHint(Text("Importa in Somto e apri scheda"))
                        }
                    }

                    if viewModel.isSearchingTMDB {
                        HStack(spacing: 8) {
                            ProgressView()
                                .scaleEffect(0.82)
                                .tint(TwoWatchTheme.brandPrimary)
                            Text("Cerco su TMDB…")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(TwoWatchTheme.textSecondary)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.top, 4)
                    }
                }
            }
        }
    }

    /// Segmented Film/Serie/Tutti filter for the Titoli scope. Client-side
    /// only: narrows down `viewModel.titles`/`tmdbResults` that are already
    /// in memory, no extra network round-trip.
    private var typeFilterChips: some View {
        @Bindable var viewModel = viewModel
        return Picker("Tipo", selection: $viewModel.typeFilter) {
            ForEach(SearchTypeFilter.allCases) { filter in
                Text(filter.label).tag(filter)
            }
        }
        .pickerStyle(.segmented)
        .accessibilityIdentifier("search-type-filter")
        .accessibilityHint(Text("Filtra i risultati per Film o Serie"))
    }

    private func titleResultCell(_ title: Title) -> some View {
        NavigationLink {
            TitleDetailView(container: container, session: session, shell: shell, titleID: title.id)
        } label: {
            SearchTitleGridCell(title: title, isTMDB: false)
        }
        .buttonStyle(.plain)
        .simultaneousGesture(TapGesture().onEnded { dismissKeyboard() })
        .accessibilityLabel(Text(title.name))
        .accessibilityHint(Text("Apri scheda titolo"))
        .contextMenu {
            Button {
                dismissKeyboard()
            } label: {
                Label("Vedi scheda", systemImage: "info.circle")
            }

            Button {
                requestQuickAdd(titleID: title.id)
            } label: {
                Label(
                    viewModel.addedToWatchlistIDs.contains(title.id) ? "Già in watchlist" : "Aggiungi a watchlist",
                    systemImage: viewModel.addedToWatchlistIDs.contains(title.id) ? "checkmark" : "plus"
                )
            }
            .disabled(viewModel.addingToWatchlistIDs.contains(title.id))
        }
        .overlay(alignment: .topLeading) {
            quickAddBadge(for: title.id)
        }
    }

    /// Small "+" affordance layered on the poster so quick-add doesn't
    /// require discovering the context menu. Tapping it never navigates.
    @ViewBuilder
    private func quickAddBadge(for titleID: String) -> some View {
        Button {
            requestQuickAdd(titleID: titleID)
        } label: {
            ZStack {
                Circle().fill(.ultraThinMaterial)
                if viewModel.addingToWatchlistIDs.contains(titleID) {
                    ProgressView().scaleEffect(0.6)
                } else if viewModel.addedToWatchlistIDs.contains(titleID) {
                    Image(systemName: "checkmark")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.brandPrimary)
                } else {
                    Image(systemName: "plus")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                }
            }
            .frame(width: 26, height: 26)
        }
        .buttonStyle(.plain)
        .padding(6)
        .disabled(viewModel.addingToWatchlistIDs.contains(titleID))
        .accessibilityLabel(Text(
            viewModel.addedToWatchlistIDs.contains(titleID) ? "Già in watchlist" : "Aggiungi a watchlist"
        ))
    }

    /// Routes a quick-add tap through the auth gate: unauthenticated users
    /// get the same sign-in sheet used elsewhere in the app instead of a
    /// silently failing Firestore write.
    private func requestQuickAdd(titleID: String) {
        guard let uid = session.appUser?.id else {
            shell.presentAuth()
            return
        }
        Task {
            await viewModel.quickAddToWatchlist(
                titleID: titleID,
                userID: uid,
                watchlistRepository: container.watchlistRepository
            )
#if canImport(UIKit)
            if viewModel.addedToWatchlistIDs.contains(titleID) {
                UINotificationFeedbackGenerator().notificationOccurred(.success)
            }
#endif
        }
    }

    /// Explicit empty-state for when the type filter hides every result,
    /// distinct from a genuine "no results" so the user understands the
    /// data exists — the filter is just narrow.
    private var filteredOutState: some View {
        VStack(spacing: 14) {
            EmptyStateView(
                title: "Nessun risultato per questo tipo",
                message: "Ho trovato titoli per \"\(viewModel.query)\", ma nessuno corrisponde al filtro \(viewModel.typeFilter.label).",
                systemImage: "line.3.horizontal.decrease.circle"
            )

            Button {
                viewModel.typeFilter = .all
            } label: {
                Label("Mostra tutti i tipi", systemImage: "xmark.circle.fill")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(PrimaryButtonStyle())
        }
    }

    /// Poster-grid skeleton shown while the first title search round-trip is
    /// in flight. Prevents the screen from ever looking "silently broken"
    /// during a slow catalog/TMDB fetch.
    private var titleGridSkeleton: some View {
        LazyVGrid(columns: titleGridColumns, spacing: 14) {
            ForEach(0 ..< 6, id: \.self) { _ in
                VStack(alignment: .leading, spacing: 6) {
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(TwoWatchTheme.panelStrong)
                        .aspectRatio(2 / 3, contentMode: .fit)
                    RoundedRectangle(cornerRadius: 4)
                        .fill(TwoWatchTheme.panelStrong)
                        .frame(height: 12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    RoundedRectangle(cornerRadius: 4)
                        .fill(TwoWatchTheme.panelStrong)
                        .frame(height: 10)
                        .frame(maxWidth: 60, alignment: .leading)
                }
                .redacted(reason: .placeholder)
            }
        }
        .accessibilityLabel(Text("Caricamento risultati in corso"))
    }

    /// Centralised friendly "no results" block. Offers two recovery actions:
    /// switch to people search (a frequent intent miss) and clear the query.
    private var noResultsState: some View {
        VStack(spacing: 14) {
            EmptyStateView(
                title: "Nessun titolo trovato",
                message: "Prova a controllare l'ortografia, oppure cerca direttamente l'autore o il cast.",
                systemImage: "film.stack.fill"
            )

            HStack(spacing: 10) {
                Button {
                    viewModel.scope = .people
                } label: {
                    Label("Cerca tra le persone", systemImage: "person.text.rectangle.fill")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(PrimaryButtonStyle())
                .accessibilityHint(Text("Mantiene la query attuale ma cerca attori e registi"))

                Button {
                    viewModel.query = ""
                    dismissKeyboard()
                } label: {
                    Label("Pulisci", systemImage: "xmark.circle.fill")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .tint(TwoWatchTheme.textPrimary)
            }
        }
    }

    private var usersContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            if !session.permissions.canSearchUsers {
                EmptyStateView(
                    title: "Accesso richiesto",
                    message: "Devi accedere a Somto per cercare altre persone.",
                    systemImage: "lock.fill",
                    actionTitle: "Accedi"
                ) {
                    shell.presentAuth()
                }
            } else if viewModel.query.isEmpty {
                idleSuggestions(for: .users, helperMessage: "Digita il nome utente o tocca una ricerca recente.")
            } else if !viewModel.isLoading, viewModel.users.isEmpty, !SearchNormalizer.normalize(viewModel.query).isEmpty {
                EmptyStateView(
                    title: "Nessun profilo trovato",
                    message: "Prova con un'altra grafia: la ricerca usa il prefisso del nome utente.",
                    systemImage: "person.crop.circle.badge.questionmark"
                )
            } else {
                ForEach(viewModel.users) { user in
                    NavigationLink {
                        UserProfileDetailView(container: container, session: session, shell: shell, userID: user.id)
                    } label: {
                        GlassCard {
                            HStack(spacing: 14) {
                                avatar(url: user.avatarURL, label: String(user.displayName.prefix(1)))
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(user.displayName)
                                        .font(.headline)
                                        .foregroundStyle(TwoWatchTheme.textPrimary)
                                    Text("@\(user.displayNameLower)")
                                        .font(.subheadline)
                                        .foregroundStyle(TwoWatchTheme.textSecondary)
                                }
                                Spacer()
                            }
                            .frame(minHeight: 56)
                        }
                    }
                    .buttonStyle(.plain)
                    .simultaneousGesture(TapGesture().onEnded { dismissKeyboard() })
                    .accessibilityLabel(Text(user.displayName))
                    .accessibilityHint(Text("Apri profilo @\(user.displayNameLower)"))
                }
            }
        }
    }

    private var genresContent: some View {
        let normalizedQuery = SearchNormalizer.normalize(viewModel.query)
        let filteredGenres = viewModel.query.isEmpty
            ? viewModel.genres
            : viewModel.genres.filter { $0.nameLower.contains(normalizedQuery) }

        return VStack(alignment: .leading, spacing: 12) {
            // Bootstrap iniziale dei generi (1 sola read, poi cache in memoria):
            // senza questo stato la schermata resterebbe vuota e "silenziosa"
            // per la frazione di secondo prima che `listGenres` risponda.
            if viewModel.genres.isEmpty, viewModel.isLoading || viewModel.searchActivity != .idle {
                genreListSkeleton
            } else if !viewModel.query.isEmpty, filteredGenres.isEmpty, !viewModel.genres.isEmpty {
                EmptyStateView(
                    title: "Nessun genere",
                    message: "Nessun genere corrisponde a \"\(viewModel.query)\".",
                    systemImage: "rectangle.stack.badge.minus"
                )
            }

            ForEach(filteredGenres) { genre in
                NavigationLink {
                    GenreTitlesView(container: container, session: session, shell: shell, genre: genre)
                } label: {
                    GlassCard {
                        HStack {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(genre.name)
                                    .font(.headline)
                                    .foregroundStyle(TwoWatchTheme.textPrimary)
                                Text("Apri i titoli di questo genere")
                                    .font(.caption)
                                    .foregroundStyle(TwoWatchTheme.textSecondary)
                            }
                            Spacer()
                            Image(systemName: "chevron.right")
                                .foregroundStyle(TwoWatchTheme.textSecondary)
                        }
                        .frame(minHeight: 44)
                    }
                }
                .buttonStyle(.plain)
                .simultaneousGesture(TapGesture().onEnded { dismissKeyboard() })
                .accessibilityLabel(Text(genre.name))
                .accessibilityHint(Text("Apri elenco titoli del genere"))
            }
        }
    }

    /// Shown once, at most for the single `listGenres` round-trip, while the
    /// genre list bootstraps. `viewModel.genres` is cached in-memory after
    /// the first load so this never repeats within the same session.
    private var genreListSkeleton: some View {
        VStack(spacing: 12) {
            ForEach(0 ..< 6, id: \.self) { _ in
                HStack {
                    VStack(alignment: .leading, spacing: 6) {
                        RoundedRectangle(cornerRadius: 4)
                            .fill(TwoWatchTheme.panelStrong)
                            .frame(width: 120, height: 14)
                        RoundedRectangle(cornerRadius: 4)
                            .fill(TwoWatchTheme.panelStrong)
                            .frame(width: 180, height: 11)
                    }
                    Spacer()
                }
                .frame(minHeight: 44)
                .padding(14)
                .background(TwoWatchTheme.panel, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            }
        }
        .redacted(reason: .placeholder)
        .accessibilityLabel(Text("Caricamento generi in corso"))
    }

    private var peopleContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            if viewModel.query.isEmpty {
                idleSuggestions(for: .people, helperMessage: "Cerca attori e registi: ottieni filmografia e arricchimento da TMDB.")
            } else if !viewModel.isLoading, viewModel.people.isEmpty, !SearchNormalizer.normalize(viewModel.query).isEmpty {
                EmptyStateView(
                    title: "Nessuna persona trovata",
                    message: "Prova a cercare per nome completo o un altro alias del professionista.",
                    systemImage: "person.crop.circle.badge.questionmark"
                )
            } else {
                ForEach(viewModel.people) { person in
                    NavigationLink {
                        PersonTitlesView(container: container, session: session, shell: shell, person: person)
                    } label: {
                        GlassCard {
                            HStack(spacing: 14) {
                                avatar(url: person.avatarURL, label: String(person.name.prefix(1)))
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(person.name)
                                        .font(.headline)
                                        .foregroundStyle(TwoWatchTheme.textPrimary)
                                    Text(person.roles.joined(separator: " • "))
                                        .font(.subheadline)
                                        .foregroundStyle(TwoWatchTheme.textSecondary)
                                }
                                Spacer()
                            }
                            .frame(minHeight: 56)
                        }
                    }
                    .buttonStyle(.plain)
                    .simultaneousGesture(TapGesture().onEnded { dismissKeyboard() })
                    .accessibilityLabel(Text(person.name))
                    .accessibilityHint(Text(person.roles.isEmpty ? "Apri filmografia" : "Apri filmografia, ruoli \(person.roles.joined(separator: ", "))"))
                }
            }
        }
    }

    /// Idle landing view shown when the query is empty. Combines persisted
    /// recent searches with curated examples so the search field never feels
    /// like an empty wall.
    @ViewBuilder
    private func idleSuggestions(for scope: SearchScope, helperMessage: LocalizedStringKey) -> some View {
        let recent = viewModel.recentQueries(for: scope)
        let suggestions = scope.suggestions

        VStack(alignment: .leading, spacing: 16) {
            SearchHintCard(systemImage: scope.systemImage, message: helperMessage)

            if !recent.isEmpty {
                SearchSuggestionStrip(
                    title: "Ricerche recenti",
                    icon: "clock.arrow.circlepath",
                    trailing: {
                        Button {
                            viewModel.clearRecent(for: scope)
                        } label: {
                            Text("Cancella")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(TwoWatchTheme.textSecondary)
                        }
                        .accessibilityLabel(Text("Cancella ricerche recenti"))
                    }
                ) {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(recent, id: \.self) { entry in
                            HStack(spacing: 10) {
                                Button {
                                    viewModel.applyRecent(entry)
                                } label: {
                                    HStack(spacing: 10) {
                                        Image(systemName: "magnifyingglass")
                                            .font(.caption)
                                            .foregroundStyle(TwoWatchTheme.textSecondary)
                                        Text(entry)
                                            .font(.callout)
                                            .foregroundStyle(TwoWatchTheme.textPrimary)
                                            .lineLimit(1)
                                        Spacer(minLength: 0)
                                    }
                                    .frame(minHeight: 44)
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                .accessibilityHint(Text("Riusa questa ricerca"))

                                Button {
                                    viewModel.removeRecent(entry, scope: scope)
                                } label: {
                                    Image(systemName: "xmark")
                                        .font(.caption.weight(.semibold))
                                        .foregroundStyle(TwoWatchTheme.textMuted)
                                        .padding(8)
                                        .background(
                                            Circle().fill(TwoWatchTheme.panel)
                                        )
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel(Text("Rimuovi \(entry) dalle recenti"))
                            }
                        }
                    }
                }
            }

            if !suggestions.isEmpty {
                SearchSuggestionStrip(
                    title: recent.isEmpty ? "Idee per iniziare" : "Esempi",
                    icon: "sparkles"
                ) {
                    FlowChips(items: suggestions) { suggestion in
                        Button {
                            viewModel.applyRecent(suggestion)
                        } label: {
                            Text(suggestion)
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(TwoWatchTheme.textPrimary)
                                .padding(.horizontal, 14)
                                .padding(.vertical, 9)
                                .frame(minHeight: 36)
                                .background(
                                    Capsule(style: .continuous).fill(TwoWatchTheme.panel)
                                )
                                .overlay(
                                    Capsule(style: .continuous)
                                        .stroke(TwoWatchTheme.border, lineWidth: 1)
                                )
                        }
                        .buttonStyle(.plain)
                        .accessibilityHint(Text("Avvia una ricerca con questo termine"))
                    }
                }
            }
        }
    }

    private func avatar(url: URL?, label: String) -> some View {
        CachedAsyncImage(url: url) { phase in
            switch phase {
            case let .success(image):
                image.resizable().scaledToFill()
            default:
                ZStack {
                    Circle().fill(TwoWatchTheme.panelStrong)
                    Text(label)
                        .font(.headline.bold())
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                }
            }
        }
        .frame(width: 46, height: 46)
        .clipShape(Circle())
    }
}

#if DEBUG
#Preview("Search") {
    NavigationStack {
        SearchView(
            container: TwoWatchPreview.container,
            session: TwoWatchPreview.session(),
            shell: TwoWatchPreview.shell(),
            previewViewModel: TwoWatchPreview.searchViewModel()
        )
    }
}
#endif

struct SearchTitleRow: View {
    let title: Title

    var body: some View {
        GlassCard {
            HStack(spacing: 14) {
                PosterImageView(url: title.posterPath, width: 72, height: 108, cornerRadius: 16)
                VStack(alignment: .leading, spacing: 6) {
                    Text(title.name)
                        .font(.headline)
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                    Text(title.subtitle)
                        .font(.subheadline)
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                    if let description = title.description {
                        Text(description)
                            .font(.caption)
                            .foregroundStyle(TwoWatchTheme.textSecondary)
                            .lineLimit(3)
                    }
                }
                Spacer()
            }
        }
    }
}

private struct SearchGridPoster: View {
    let url: URL?
    let cornerRadius: CGFloat = 14

    var body: some View {
        Group {
            if let url {
                CachedAsyncImage(url: url) { phase in
                    switch phase {
                    case let .success(image):
                        image.resizable().scaledToFill()
                    case .failure:
                        placeholder
                    case .empty:
                        ZStack {
                            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                                .fill(TwoWatchTheme.panelStrong)
                            ProgressView().tint(TwoWatchTheme.textSecondary)
                        }
                    @unknown default:
                        placeholder
                    }
                }
            } else {
                placeholder
            }
        }
        .frame(maxWidth: .infinity, minHeight: 150)
        .aspectRatio(2 / 3, contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
    }

    private var placeholder: some View {
        ZStack {
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .fill(TwoWatchTheme.panelStrong)
            Image(systemName: "film")
                .font(.title3)
                .foregroundStyle(TwoWatchTheme.textMuted)
        }
    }
}

private struct TMDBTag: View {
    var body: some View {
        Text("TMDB")
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(.white)
            .padding(.horizontal, 5)
            .padding(.vertical, 2)
            .background(TwoWatchTheme.accent.opacity(0.85), in: RoundedRectangle(cornerRadius: 4, style: .continuous))
            .padding(6)
    }
}

struct SearchTitleGridCell: View {
    let title: Title
    let isTMDB: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ZStack(alignment: .topTrailing) {
                SearchGridPoster(url: title.posterPath)

                if isTMDB {
                    TMDBTag()
                }
            }

            Text(title.name)
                .font(.caption.weight(.semibold))
                .foregroundStyle(TwoWatchTheme.textPrimary)
                .lineLimit(2)

            Text(title.subtitle)
                .font(.caption2)
                .foregroundStyle(TwoWatchTheme.textSecondary)
                .lineLimit(1)
        }
    }
}

struct SearchTMDBGridCell: View {
    let item: TMDBSearchResult
    let isResolving: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ZStack(alignment: .topTrailing) {
                ZStack {
                    SearchGridPoster(url: item.posterURL)

                    if isResolving {
                        Color.black.opacity(0.5)
                            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                        ProgressView()
                            .tint(.white)
                    }
                }

                TMDBTag()
            }

            Text(item.title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(TwoWatchTheme.textPrimary)
                .lineLimit(2)

            Text("\(item.mediaType.label)\(item.year.map { " • \($0)" } ?? "")")
                .font(.caption2)
                .foregroundStyle(TwoWatchTheme.textSecondary)
                .lineLimit(1)
        }
    }
}

/// Compact helper card shown when the user lands on Search with an empty
/// query. Gives a one-liner explaining what the current scope will search.
struct SearchHintCard: View {
    let systemImage: String
    let message: LocalizedStringKey

    var body: some View {
        GlassCard {
            HStack(alignment: .top, spacing: 14) {
                ZStack {
                    Circle().fill(TwoWatchTheme.brandPrimary.opacity(0.18))
                    Image(systemName: systemImage)
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(TwoWatchTheme.brandPrimary)
                }
                .frame(width: 38, height: 38)

                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(TwoWatchTheme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)

                Spacer(minLength: 0)
            }
        }
    }
}

/// Section wrapper used for "Ricerche recenti" and "Idee per iniziare".
/// Standardises the header + content layout and keeps the content closure
/// agnostic about styling.
struct SearchSuggestionStrip<Trailing: View, Content: View>: View {
    let title: LocalizedStringKey
    let icon: String
    /// Generico invece di `AnyView?`: la type erasure toglieva a SwiftUI
    /// l'identita' della view accessoria, e con lei la possibilita' di saltare
    /// il sotto-albero nel diffing (docs/context/IOS_CODE_STYLE.md §6.1).
    @ViewBuilder var trailing: () -> Trailing
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: icon)
                    .font(.caption.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.textSecondary)
                Text(title)
                    .font(.caption.weight(.bold).smallCaps())
                    .foregroundStyle(TwoWatchTheme.textSecondary)
                Spacer(minLength: 8)
                trailing()
            }

            content()
        }
    }
}

extension SearchSuggestionStrip where Trailing == EmptyView {
    init(
        title: LocalizedStringKey,
        icon: String,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.init(title: title, icon: icon, trailing: { EmptyView() }, content: content)
    }
}

/// Lightweight wrapping chips layout. Uses `Layout` so chips break to a new
/// row when they overflow the available width. We avoid `LazyVGrid` here
/// because we want true left-aligned wrapping, not equal-width columns.
struct FlowChips<Data: RandomAccessCollection, Content: View>: View where Data.Element: Hashable {
    let items: Data
    let spacing: CGFloat
    let runSpacing: CGFloat
    @ViewBuilder var content: (Data.Element) -> Content

    init(
        items: Data,
        spacing: CGFloat = 8,
        runSpacing: CGFloat = 8,
        @ViewBuilder content: @escaping (Data.Element) -> Content
    ) {
        self.items = items
        self.spacing = spacing
        self.runSpacing = runSpacing
        self.content = content
    }

    var body: some View {
        FlowLayout(spacing: spacing, runSpacing: runSpacing) {
            ForEach(Array(items), id: \.self) { item in
                content(item)
            }
        }
    }
}

private struct FlowLayout: Layout {
    let spacing: CGFloat
    let runSpacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0
        var maxRowWidth: CGFloat = 0

        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x + size.width > maxWidth, x > 0 {
                maxRowWidth = max(maxRowWidth, x - spacing)
                x = 0
                y += rowHeight + runSpacing
                rowHeight = 0
            }
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
        maxRowWidth = max(maxRowWidth, x - spacing)
        return CGSize(width: maxRowWidth.isFinite ? max(0, maxRowWidth) : 0, height: y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let maxWidth = bounds.width
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0

        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x + size.width > maxWidth, x > 0 {
                x = 0
                y += rowHeight + runSpacing
                rowHeight = 0
            }
            view.place(
                at: CGPoint(x: bounds.minX + x, y: bounds.minY + y),
                anchor: .topLeading,
                proposal: ProposedViewSize(width: size.width, height: size.height)
            )
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}

struct SearchActivityCard: View {
    let title: String
    let message: String?

    var body: some View {
        GlassCard {
            HStack(alignment: .top, spacing: 14) {
                ZStack {
                    Circle()
                        .fill(TwoWatchTheme.brandPrimary.opacity(0.18))
                    ProgressView()
                        .tint(TwoWatchTheme.brandPrimary)
                }
                .frame(width: 42, height: 42)

                VStack(alignment: .leading, spacing: 4) {
                    Text(title)
                        .font(.headline)
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                    if let message, !message.isEmpty {
                        Text(message)
                            .font(.subheadline)
                            .foregroundStyle(TwoWatchTheme.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                Spacer()
            }
        }
    }
}

struct GenreTitlesView: View {
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore
    let genre: Genre
    @State private var titles: [Title] = []
    @State private var isLoading = true
    @State private var errorMessage: String?
    @State private var typeFilter: SearchTypeFilter = .all
    /// Race guard: `.task(id:)` already cancels/restarts on genre change, but
    /// we additionally drop stale results by token so a slow first fetch
    /// can never overwrite what a faster second fetch already rendered
    /// (equivalent bug to the web report: back out, open another genre,
    /// land on an empty/stale screen).
    @State private var latestToken = UUID()

    private let gridColumns = [
        GridItem(.flexible(), spacing: 14),
        GridItem(.flexible(), spacing: 14),
        GridItem(.flexible(), spacing: 14)
    ]

    private var filteredTitles: [Title] {
        guard let mediaType = typeFilter.mediaType else { return titles }
        return titles.filter { $0.type == mediaType }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Picker("Tipo", selection: $typeFilter) {
                    ForEach(SearchTypeFilter.allCases) { filter in
                        Text(filter.label).tag(filter)
                    }
                }
                .pickerStyle(.segmented)
                .accessibilityHint(Text("Filtra i titoli del genere per Film o Serie"))

                if isLoading {
                    genreTitlesSkeleton
                } else if titles.isEmpty {
                    EmptyStateView(
                        title: "Nessun titolo trovato",
                        message: "Per ora non ci sono titoli approvati per questo genere.",
                        systemImage: "rectangle.stack.badge.minus"
                    )
                    .padding(.top, 16)
                } else if filteredTitles.isEmpty {
                    EmptyStateView(
                        title: "Nessun risultato per questo tipo",
                        message: "Nessun titolo di tipo \(typeFilter.label) in questo genere.",
                        systemImage: "line.3.horizontal.decrease.circle"
                    )
                    .padding(.top, 16)
                } else {
                    LazyVGrid(columns: gridColumns, spacing: 14) {
                        ForEach(filteredTitles) { title in
                            NavigationLink {
                                TitleDetailView(container: container, session: session, shell: shell, titleID: title.id)
                            } label: {
                                SearchTitleGridCell(title: title, isTMDB: false)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(Text(title.name))
                            .accessibilityHint(Text("Apri scheda titolo"))
                        }
                    }
                }
            }
            .padding(20)
        }
        .background(TwoWatchBackground())
        .navigationTitle(genre.name)
        .task(id: genre.id) {
            let token = UUID()
            latestToken = token
            isLoading = true
            do {
                let result = try await container.titleRepository.titlesForGenre(genre.id)
                guard token == latestToken else { return }
                titles = result
                isLoading = false
            } catch {
                guard token == latestToken else { return }
                errorMessage = UserFacingError.message(for: error)
                isLoading = false
            }
        }
        .alert("Errore", isPresented: Binding(get: { errorMessage != nil }, set: { _ in errorMessage = nil })) {
            Button("Chiudi", role: .cancel) {}
        } message: {
            Text(errorMessage ?? "")
        }
    }

    private var genreTitlesSkeleton: some View {
        LazyVGrid(columns: gridColumns, spacing: 14) {
            ForEach(0 ..< 6, id: \.self) { _ in
                VStack(alignment: .leading, spacing: 6) {
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(TwoWatchTheme.panelStrong)
                        .aspectRatio(2 / 3, contentMode: .fit)
                    RoundedRectangle(cornerRadius: 4)
                        .fill(TwoWatchTheme.panelStrong)
                        .frame(height: 12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .redacted(reason: .placeholder)
            }
        }
        .accessibilityLabel(Text("Caricamento titoli in corso"))
    }
}

/// Variante usata quando non abbiamo un `personID` strutturato per
/// l'attore: facciamo un best-effort scan dei titoli che hanno il nome
/// nel campo `cast` o `directors`.
struct PersonNameTitlesView: View {
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore
    let personName: String
    let avatarURL: URL?
    @State private var titles: [Title] = []
    @State private var isLoading = true
    @State private var errorMessage: String?
    /// Race guard, same pattern as `GenreTitlesView`/`PersonTitlesView`.
    @State private var latestToken = UUID()

    var body: some View {
        ScrollView {
            VStack(spacing: 12) {
                if isLoading {
                    personTitlesSkeleton
                } else if titles.isEmpty {
                    EmptyStateView(
                        title: "Nessun titolo trovato",
                        message: "Per ora non ho altri titoli con \(personName) nel cast o alla regia. Prova a cercare il nome nella ricerca.",
                        systemImage: "person.crop.circle.badge.questionmark"
                    )
                    .padding(.top, 16)
                } else {
                    ForEach(titles) { title in
                        NavigationLink {
                            TitleDetailView(container: container, session: session, shell: shell, titleID: title.id)
                        } label: {
                            SearchTitleRow(title: title)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .padding(20)
        }
        .background(TwoWatchBackground())
        .navigationTitle(personName)
        .task(id: personName) {
            let token = UUID()
            latestToken = token
            isLoading = true
            do {
                let results = try await container.titleRepository.titlesForPersonName(personName)
                guard token == latestToken else { return }
                titles = results
                isLoading = false
            } catch {
                guard token == latestToken else { return }
                errorMessage = UserFacingError.message(for: error)
                isLoading = false
            }
        }
        .alert("Errore", isPresented: Binding(get: { errorMessage != nil }, set: { _ in errorMessage = nil })) {
            Button("Chiudi", role: .cancel) {}
        } message: {
            Text(errorMessage ?? "")
        }
    }

    private var personTitlesSkeleton: some View {
        VStack(spacing: 12) {
            ForEach(0 ..< 3, id: \.self) { _ in
                HStack(spacing: 12) {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(TwoWatchTheme.panelStrong)
                        .frame(width: 72, height: 108)
                    VStack(alignment: .leading, spacing: 8) {
                        RoundedRectangle(cornerRadius: 4)
                            .fill(TwoWatchTheme.panelStrong)
                            .frame(height: 14)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        RoundedRectangle(cornerRadius: 4)
                            .fill(TwoWatchTheme.panelStrong)
                            .frame(height: 12)
                            .frame(maxWidth: 140, alignment: .leading)
                    }
                    Spacer(minLength: 0)
                }
                .padding(12)
                .background(TwoWatchTheme.panel, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            }
        }
        .redacted(reason: .placeholder)
        .accessibilityLabel(Text("Caricamento titoli in corso"))
    }
}

struct PersonTitlesView: View {
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore
    let person: Person
    @State private var titles: [Title] = []
    @State private var errorMessage: String?
    /// `true` until the first local-catalog fetch resolves. Without this the
    /// screen could show "Nessun titolo trovato" for a frame before the
    /// query returns — the same "looks silently broken" bug reported on web.
    @State private var isLoadingLocal = true
    /// `true` while we're hitting TMDB for the rest of the filmography and
    /// importing missing titles. Drives the skeleton row at the bottom of
    /// the list so the user knows more content is on the way.
    @State private var isEnrichingFromTMDB = false
    /// Race guard: cancels stale writes if the user backs out and opens a
    /// different person before the previous fetch/enrichment resolves.
    @State private var latestToken = UUID()

    var body: some View {
        ScrollView {
            VStack(spacing: 12) {
                if isLoadingLocal {
                    personEnrichmentSkeleton
                } else {
                    ForEach(titles) { title in
                        NavigationLink {
                            TitleDetailView(container: container, session: session, shell: shell, titleID: title.id)
                        } label: {
                            SearchTitleRow(title: title)
                        }
                        .buttonStyle(.plain)
                    }

                    if isEnrichingFromTMDB {
                        personEnrichmentSkeleton
                    }

                    if !isEnrichingFromTMDB && titles.isEmpty {
                        EmptyStateView(
                            title: "Nessun titolo trovato",
                            message: "Per ora non ci sono titoli locali per \(person.name).",
                            systemImage: "person.crop.circle.badge.questionmark"
                        )
                        .padding(.top, 16)
                    }
                }
            }
            .padding(20)
        }
        .background(TwoWatchBackground())
        .navigationTitle(person.name)
        .task(id: person.id) {
            let token = UUID()
            latestToken = token
            isLoadingLocal = true
            await loadLocalAndEnrich(token: token)
        }
        .alert("Errore", isPresented: Binding(get: { errorMessage != nil }, set: { _ in errorMessage = nil })) {
            Button("Chiudi", role: .cancel) {}
        } message: {
            Text(errorMessage ?? "")
        }
    }

    /// Loads the local filmography first (cheap, instant), then fans out to
    /// TMDB on a background task to back-fill any missing titles. The local
    /// list is re-read after the enrichment so newly imported titles appear
    /// without leaving the page. Every write is guarded by `token` so a
    /// stale in-flight call from a previous person can never clobber the
    /// current screen's state.
    private func loadLocalAndEnrich(token: UUID) async {
        do {
            let localTitles = try await container.titleRepository.titlesForPerson(person.id)
            guard token == latestToken else { return }
            titles = localTitles
            isLoadingLocal = false
        } catch {
            guard token == latestToken else { return }
            errorMessage = UserFacingError.message(for: error)
            isLoadingLocal = false
        }

        guard let personTMDBID = Int(person.id) else { return }
        isEnrichingFromTMDB = true
        defer { if token == latestToken { isEnrichingFromTMDB = false } }
        let imported = await container.titleRepository.enrichLocalCatalog(
            forPersonTMDBID: personTMDBID,
            currentUser: session.appUser
        )
        guard imported > 0, token == latestToken else { return }
        if let refreshed = try? await container.titleRepository.titlesForPerson(person.id) {
            guard token == latestToken else { return }
            titles = refreshed
        }
    }

    private var personEnrichmentSkeleton: some View {
        VStack(spacing: 12) {
            ForEach(0 ..< 3, id: \.self) { _ in
                HStack(spacing: 12) {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(TwoWatchTheme.panelStrong)
                        .frame(width: 56, height: 84)
                    VStack(alignment: .leading, spacing: 8) {
                        RoundedRectangle(cornerRadius: 4)
                            .fill(TwoWatchTheme.panelStrong)
                            .frame(height: 14)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        RoundedRectangle(cornerRadius: 4)
                            .fill(TwoWatchTheme.panelStrong)
                            .frame(height: 12)
                            .frame(maxWidth: 140, alignment: .leading)
                    }
                    Spacer(minLength: 0)
                }
                .padding(12)
                .background(TwoWatchTheme.panel, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            }
        }
        .accessibilityLabel("Caricamento titoli da TMDB in corso")
    }
}
