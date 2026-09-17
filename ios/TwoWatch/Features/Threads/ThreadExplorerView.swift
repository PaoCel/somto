import Observation
import SwiftUI

/// Le discussioni di un titolo, già divise per livello.
struct TitleThreadTree {
    let title: Title
    /// Discussione generale della serie/film (può non esistere ancora).
    let titleThread: AppThread?
    /// Discussioni di stagione esistenti, per numero di stagione.
    let seasonThreads: [Int: AppThread]
    /// Discussioni di episodio esistenti, raggruppate per stagione.
    let episodeThreads: [Int: [(episode: Int, thread: AppThread)]]

    var totalThreads: Int {
        (titleThread == nil ? 0 : 1)
            + seasonThreads.count
            + episodeThreads.values.reduce(0) { $0 + $1.count }
    }

    /// Stagioni da elencare: quelle del catalogo, più eventuali stagioni che
    /// hanno già una discussione ma non risultano nei metadati (import vecchi,
    /// numerazioni anime non allineate a TMDB).
    var seasonNumbers: [Int] {
        let fromCatalog = title.metadata.seasons.map(\.seasonNumber)
        let fromThreads = Set(seasonThreads.keys).union(episodeThreads.keys)
        return Array(Set(fromCatalog).union(fromThreads)).sorted()
    }

    static func build(title: Title, threads: [AppThread]) -> TitleThreadTree {
        var titleThread: AppThread?
        var seasonThreads: [Int: AppThread] = [:]
        var episodeThreads: [Int: [(episode: Int, thread: AppThread)]] = [:]

        for thread in threads {
            switch thread.scope {
            case .title:
                titleThread = thread
            case .season(let season):
                seasonThreads[season] = thread
            case .episode(let season, let episode):
                episodeThreads[season, default: []].append((episode, thread))
            case .directMessage, .group:
                continue
            }
        }

        for key in episodeThreads.keys {
            episodeThreads[key]?.sort { $0.episode < $1.episode }
        }

        return TitleThreadTree(
            title: title,
            titleThread: titleThread,
            seasonThreads: seasonThreads,
            episodeThreads: episodeThreads
        )
    }
}

@Observable
@MainActor
final class ThreadExplorerViewModel {
    private let titleRepository: TitleRepository
    private let threadsRepository: ThreadsRepository

    var query = ""
    var results: [Title] = []
    var selectedTree: TitleThreadTree?
    var isSearching = false
    var isLoadingTree = false
    var loadingTitleID: String?
    var errorMessage: String?

    @ObservationIgnored private var searchTask: Task<Void, Never>?

    init(titleRepository: TitleRepository, threadsRepository: ThreadsRepository) {
        self.titleRepository = titleRepository
        self.threadsRepository = threadsRepository
    }

    /// Ricerca con debounce: la digitazione non spara una query per carattere.
    func search(_ raw: String) {
        query = raw
        searchTask?.cancel()

        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 2 else {
            results = []
            isSearching = false
            return
        }

        isSearching = true
        searchTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 280_000_000)
            guard !Task.isCancelled else { return }
            defer { isSearching = false }
            do {
                results = try await titleRepository.searchTitles(trimmed, limit: 20)
            } catch {
                guard !Task.isCancelled else { return }
                errorMessage = UserFacingError.message(for: error)
                results = []
            }
        }
    }

    func select(_ title: Title) async {
        guard !isLoadingTree else { return }
        isLoadingTree = true
        loadingTitleID = title.id
        errorMessage = nil
        defer {
            isLoadingTree = false
            loadingTitleID = nil
        }
        do {
            let threads = try await threadsRepository.listPublicThreadsForTitle(title.id)
            selectedTree = TitleThreadTree.build(title: title, threads: threads)
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }

    func clearSelection() {
        selectedTree = nil
    }
}

/// "Esplora tutti i thread": cerchi una serie o un film e vedi **tutte** le sue
/// discussioni, divise per livello — generale, stagioni, episodi.
///
/// I tre livelli restano separati (è la separazione che protegge dagli spoiler
/// e tiene le conversazioni in contesto), ma qui hanno finalmente una casa
/// unica: prima l'unico modo di trovare la discussione di un episodio era
/// passare dalla scheda titolo → tab Episodi → riga → "Commenti".
struct ThreadExplorerView: View {
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore

    /// Titolo su cui aprirsi già posizionati (dalla scheda titolo). `nil` →
    /// si parte dalla ricerca.
    let initialTitle: Title?

    @State private var viewModel: ThreadExplorerViewModel
    @State private var expandedSeasons: Set<Int> = []
    @Environment(\.dismiss) private var dismiss

    init(
        container: AppContainer,
        session: SessionStore,
        shell: AppShellStore,
        initialTitle: Title? = nil
    ) {
        self.container = container
        self.session = session
        self.shell = shell
        self.initialTitle = initialTitle
        _viewModel = State(initialValue: ThreadExplorerViewModel(
            titleRepository: container.titleRepository,
            threadsRepository: container.threadsRepository
        ))
    }

    var body: some View {
        NavigationStack {
            Group {
                if let tree = viewModel.selectedTree {
                    treeView(tree)
                } else {
                    searchView
                }
            }
            .background(TwoWatchBackground())
            .navigationTitle(viewModel.selectedTree?.title.name ?? String(localized: "Trova una discussione"))
            .navigationBarTitleDisplayMode(.inline)
            .task {
                // Aperto dalla scheda di un titolo: si salta la ricerca.
                if let initialTitle, viewModel.selectedTree == nil {
                    await viewModel.select(initialTitle)
                }
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    if viewModel.selectedTree != nil {
                        Button("Cerca") { viewModel.clearSelection() }
                            .foregroundStyle(TwoWatchTheme.textPrimary)
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Chiudi") { dismiss() }
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                }
            }
        }
    }

    // MARK: - Ricerca

    private var searchView: some View {
        VStack(spacing: 0) {
            searchField

            if viewModel.isSearching {
                ProgressView()
                    .tint(TwoWatchTheme.accent)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 30)
                Spacer(minLength: 0)
            } else if viewModel.results.isEmpty {
                searchPlaceholder
            } else {
                ScrollView {
                    LazyVStack(spacing: 10) {
                        ForEach(viewModel.results) { title in
                            Button {
                                Task { await viewModel.select(title) }
                            } label: {
                                HStack(spacing: 10) {
                                    SearchTitleRow(title: title)
                                    if viewModel.loadingTitleID == title.id {
                                        ProgressView()
                                            .tint(TwoWatchTheme.accent)
                                            .accessibilityLabel("Caricamento discussioni")
                                    }
                                }
                            }
                            .buttonStyle(.plain)
                            .disabled(viewModel.isLoadingTree)
                        }
                    }
                    .padding(.horizontal, 20)
                    .padding(.top, 12)
                    .padding(.bottom, 30)
                }
                .scrollDismissesKeyboard(.interactively)
            }
        }
        .alert("Errore", isPresented: Binding(
            get: { viewModel.errorMessage != nil },
            set: { if !$0 { viewModel.errorMessage = nil } }
        )) {
            Button("Chiudi", role: .cancel) {}
        } message: {
            Text(viewModel.errorMessage ?? "")
        }
    }

    private var searchField: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass")
                .font(.subheadline.weight(.bold))
                .foregroundStyle(TwoWatchTheme.textMuted)

            TextField(
                "",
                text: Binding(
                    get: { viewModel.query },
                    set: { viewModel.search($0) }
                ),
                prompt: Text("Cerca una serie o un film")
                    .foregroundStyle(TwoWatchTheme.textMuted)
            )
            .foregroundStyle(TwoWatchTheme.textPrimary)
            .autocorrectionDisabled()
            .textInputAutocapitalization(.never)
            .submitLabel(.search)

            if !viewModel.query.isEmpty {
                Button {
                    viewModel.search("")
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.subheadline)
                        .foregroundStyle(TwoWatchTheme.textMuted)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Cancella la ricerca")
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(TwoWatchTheme.panel, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(TwoWatchTheme.border, lineWidth: 1)
        )
        .padding(.horizontal, 20)
        .padding(.top, 14)
    }

    private var searchPlaceholder: some View {
        VStack(spacing: 10) {
            Spacer(minLength: 20)
            Image(systemName: "text.magnifyingglass")
                .font(.system(size: 34, weight: .light))
                .foregroundStyle(TwoWatchTheme.textMuted)
            Text(viewModel.query.count >= 2 ? "Nessun titolo trovato" : "Cerca un titolo")
                .font(.headline.weight(.bold))
                .foregroundStyle(TwoWatchTheme.textPrimary)
            Text("Poi scegli se parlare della serie, di una stagione o di un singolo episodio.")
                .font(.subheadline)
                .foregroundStyle(TwoWatchTheme.textSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)
            Spacer(minLength: 0)
        }
    }

    // MARK: - Albero delle discussioni del titolo

    private func treeView(_ tree: TitleThreadTree) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                headerCard(tree)
                generalSection(tree)
                if tree.title.type == .tv, !tree.seasonNumbers.isEmpty {
                    seasonsSection(tree)
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 16)
            .padding(.bottom, 40)
        }
        .overlay {
            if viewModel.isLoadingTree {
                ProgressView().tint(TwoWatchTheme.accent)
            }
        }
    }

    private func headerCard(_ tree: TitleThreadTree) -> some View {
        HStack(alignment: .center, spacing: 12) {
            PosterImageView(url: tree.title.posterPath, width: 54, height: 78, cornerRadius: 12)
            VStack(alignment: .leading, spacing: 3) {
                Text(tree.title.name)
                    .font(.system(size: 16, weight: .heavy))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                    .lineLimit(2)
                Text(tree.totalThreads == 0
                     ? "Nessuna discussione ancora: aprila tu"
                     : String(localized: "\(tree.totalThreads) discussioni aperte"))
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(TwoWatchTheme.textMuted)
            }
            Spacer(minLength: 0)
        }
    }

    private func generalSection(_ tree: TitleThreadTree) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionLabel("DISCUSSIONE GENERALE")
            threadRow(
                scope: .title,
                titleText: tree.title.type == .tv ? String(localized: "Tutta la serie") : tree.title.name,
                thread: tree.titleThread,
                destination: .title(tree.title.id)
            )
        }
    }

    private func seasonsSection(_ tree: TitleThreadTree) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionLabel("STAGIONI ED EPISODI")

            ForEach(tree.seasonNumbers, id: \.self) { season in
                VStack(alignment: .leading, spacing: 8) {
                    threadRow(
                        scope: .season(season),
                        titleText: "Stagione \(season)",
                        thread: tree.seasonThreads[season],
                        destination: .season(titleID: tree.title.id, season: season)
                    )

                    let episodes = tree.episodeThreads[season] ?? []
                    if !episodes.isEmpty {
                        episodeDisclosure(tree: tree, season: season, episodes: episodes)
                    }
                }
                .padding(.bottom, 4)
            }
        }
    }

    /// Gli episodi sono collassati per default: una stagione da 24 puntate
    /// (o una serie importata da TV Time, che genera un thread per episodio)
    /// renderebbe la pagina illeggibile. Si elencano solo gli episodi che una
    /// discussione ce l'hanno davvero.
    private func episodeDisclosure(
        tree: TitleThreadTree,
        season: Int,
        episodes: [(episode: Int, thread: AppThread)]
    ) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(.easeInOut(duration: 0.18)) {
                    if expandedSeasons.contains(season) {
                        expandedSeasons.remove(season)
                    } else {
                        expandedSeasons.insert(season)
                    }
                }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: expandedSeasons.contains(season) ? "chevron.down" : "chevron.right")
                        .font(.system(size: 10, weight: .heavy))
                    Text("\(episodes.count) discussioni di episodio")
                        .font(.system(size: 12, weight: .bold))
                    Spacer(minLength: 0)
                }
                .foregroundStyle(TwoWatchTheme.brandSecondary)
                .padding(.leading, 14)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if expandedSeasons.contains(season) {
                VStack(spacing: 6) {
                    ForEach(episodes, id: \.episode) { entry in
                        threadRow(
                            scope: .episode(season: season, episode: entry.episode),
                            titleText: "Episodio \(entry.episode)",
                            thread: entry.thread,
                            destination: .episode(
                                titleID: tree.title.id,
                                season: season,
                                episode: entry.episode
                            ),
                            indented: true
                        )
                    }
                }
            }
        }
    }

    private func sectionLabel(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 11, weight: .heavy, design: .rounded))
            .tracking(0.6)
            .foregroundStyle(TwoWatchTheme.textMuted)
    }

    private func threadRow(
        scope: ThreadScope,
        titleText: String,
        thread: AppThread?,
        destination: PublicThreadSeed,
        indented: Bool = false
    ) -> some View {
        NavigationLink {
            ThreadDetailView(
                container: container,
                session: session,
                shell: shell,
                threadID: threadID(for: destination),
                publicThreadSeed: destination
            )
        } label: {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: scope.symbolName)
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(scope.tint)
                    .frame(width: 30, height: 30)
                    .background(scope.tint.opacity(0.14), in: Circle())

                VStack(alignment: .leading, spacing: 4) {
                    Text(titleText)
                        .font(.system(size: 14, weight: .bold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                        .lineLimit(1)

                    if let thread, !thread.previewSplit.text.isEmpty || thread.previewSplit.score != nil {
                        HStack(spacing: 6) {
                            if let score = thread.previewSplit.score {
                                ThreadRatingBadge(score: score)
                            }
                            if !thread.previewSplit.text.isEmpty {
                                Text(thread.previewSplit.text)
                                    .font(.system(size: 12))
                                    .foregroundStyle(TwoWatchTheme.textSecondary)
                                    .lineLimit(1)
                            }
                        }
                    } else {
                        Text("Ancora nessun messaggio")
                            .font(.system(size: 12))
                            .foregroundStyle(TwoWatchTheme.textMuted)
                    }
                }

                Spacer(minLength: 0)

                Image(systemName: "chevron.right")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(TwoWatchTheme.textMuted)
                    .padding(.top, 8)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(TwoWatchTheme.panel, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .stroke(TwoWatchTheme.border, lineWidth: 1)
            )
            .padding(.leading, indented ? 14 : 0)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(titleText). \(scope.longLabel)")
    }

    private func threadID(for seed: PublicThreadSeed) -> String {
        let repository = container.threadsRepository
        switch seed {
        case .title(let titleID):
            return repository.threadIDForPublic(titleID: titleID)
        case .season(let titleID, let season):
            return repository.threadIDForSeason(titleID: titleID, season: season)
        case .episode(let titleID, let season, let episode):
            return repository.threadIDForEpisode(titleID: titleID, season: season, episode: episode)
        }
    }
}
