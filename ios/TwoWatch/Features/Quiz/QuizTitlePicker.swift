import SwiftUI

// MARK: - Title catalogue store
//
// Backs the "titolo specifico" vetrina shared by the solo setup and the friend
// challenge. Loads the complete playable catalogue from `quizMeta/themes` (one
// read) and lazily resolves posters from the `titles` collection. Seen titles
// (the caller's completed set) surface first as a personal shelf; everything
// else lives under "Altri titoli con quiz". Search filters the whole catalogue.

@Observable
@MainActor
final class QuizTitleCatalogStore {
    enum LoadState: Equatable {
        case loading
        case loaded
        case error(String)
    }

    let container: AppContainer
    /// Title ids the viewer has completed — drives the "I tuoi titoli visti"
    /// shelf. Empty is fine: the shelf just collapses.
    let seenTitleIds: Set<String>

    var state: LoadState = .loading
    /// Full playable catalogue, pre-sorted by the aggregate (count desc, title).
    private(set) var themes: [QuizTheme] = []
    /// Resolved poster art per titleId. Cells fall back to a coloured plate
    /// with the title until (and if) a poster lands here.
    private(set) var posters: [String: URL] = [:]
    var query: String = ""

    private var didLoad = false

    init(container: AppContainer, seenTitleIds: Set<String>) {
        self.container = container
        self.seenTitleIds = seenTitleIds
    }

    /// Themes the viewer has already watched and that have a quiz.
    var seenThemes: [QuizTheme] {
        themes.filter { seenTitleIds.contains($0.titleId) }
    }

    /// Everything else in the catalogue.
    var otherThemes: [QuizTheme] {
        themes.filter { !seenTitleIds.contains($0.titleId) }
    }

    /// Case/diacritic-insensitive title search across the whole catalogue.
    var filteredThemes: [QuizTheme] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return [] }
        return themes.filter {
            $0.title.range(of: q, options: [.caseInsensitive, .diacriticInsensitive]) != nil
        }
    }

    var isSearching: Bool {
        !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    func loadIfNeeded() async {
        guard !didLoad else { return }
        didLoad = true
        await load()
    }

    func load() async {
        state = .loading
        do {
            themes = try await container.quizRepository.fetchAllPlayableThemes()
            state = .loaded
            // Seen shelf first (small, fast), then the long tail in the
            // background so search and the "altri" grid fill in without
            // blocking the initial render.
            await loadPosters(for: seenThemes.map(\.titleId))
            let rest = otherThemes.map(\.titleId)
            Task { await loadPosters(for: rest) }
        } catch {
            didLoad = false
            state = .error(UserFacingError.message(for: error))
        }
    }

    /// Batch-resolves posters for the given ids (skips ones already cached).
    func loadPosters(for ids: [String]) async {
        let missing = ids.filter { posters[$0] == nil }
        guard !missing.isEmpty else { return }
        guard let titles = try? await container.titleRepository.listTitles(ids: missing) else { return }
        for title in titles where title.posterPath != nil {
            posters[title.id] = title.posterPath
        }
    }
}

// MARK: - Picker view

/// Search field + vetrina of poster tiles. Selecting a tile writes its titleId
/// into the bound `selectedTitleId`. Stateless about counts/start — the host
/// owns the "how many questions" + start affordance.
struct QuizTitlePickerView: View {
    @Bindable var store: QuizTitleCatalogStore
    @Binding var selectedTitleId: String?
    /// Fired after a tile is tapped — lets the host react (haptic, scroll).
    var onSelect: (() -> Void)?

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 10), count: 3)

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            searchField

            switch store.state {
            case .loading:
                loadingRow
            case let .error(message):
                errorRow(message)
            case .loaded:
                if store.isSearching {
                    searchResults
                } else {
                    catalogue
                }
            }
        }
        .task { await store.loadIfNeeded() }
    }

    // MARK: Search field

    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(.subheadline.weight(.bold))
                .foregroundStyle(TwoWatchTheme.textSecondary)
            TextField("Cerca un film o una serie…", text: $store.query)
                .font(.subheadline)
                .foregroundStyle(TwoWatchTheme.textPrimary)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
            if store.isSearching {
                Button {
                    store.query = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(TwoWatchTheme.textMuted)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Pulisci ricerca")
            }
        }
        .padding(.horizontal, 14)
        .frame(height: 46)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(TwoWatchTheme.panel)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(TwoWatchTheme.border, lineWidth: 1)
        )
    }

    // MARK: Catalogue (no query)

    @ViewBuilder
    private var catalogue: some View {
        if !store.seenThemes.isEmpty {
            section(title: String(localized: "I tuoi titoli visti con quiz"), themes: store.seenThemes)
        }
        if !store.otherThemes.isEmpty {
            section(
                title: store.seenThemes.isEmpty ? String(localized: "Titoli con quiz") : String(localized: "Altri titoli con quiz"),
                themes: store.otherThemes
            )
        }
        infoHint
    }

    private var infoHint: some View {
        HStack(spacing: 8) {
            Image(systemName: "info.circle.fill")
                .foregroundStyle(TwoWatchTheme.accent)
            Text("Cerca qualunque titolo: se ha un quiz, parte la partita.")
                .font(.caption)
                .foregroundStyle(TwoWatchTheme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(11)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(TwoWatchTheme.accent.opacity(0.08))
        )
        .padding(.top, 2)
    }

    // MARK: Search results

    @ViewBuilder
    private var searchResults: some View {
        if store.filteredThemes.isEmpty {
            VStack(spacing: 10) {
                Image(systemName: "questionmark.circle")
                    .font(.system(size: 30, weight: .semibold))
                    .foregroundStyle(TwoWatchTheme.textMuted)
                Text("Nessun titolo con quiz per \"\(store.query)\"")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                    .multilineTextAlignment(.center)
                Text("Prova un altro titolo, oppure gioca in modalità casuale.")
                    .font(.caption)
                    .foregroundStyle(TwoWatchTheme.textSecondary)
                    .multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 28)
        } else {
            grid(store.filteredThemes)
        }
    }

    // MARK: Shared grid

    private func section(title: String, themes: [QuizTheme]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.subheadline.weight(.bold))
                .foregroundStyle(TwoWatchTheme.textPrimary)
            grid(themes)
        }
    }

    private func grid(_ themes: [QuizTheme]) -> some View {
        LazyVGrid(columns: columns, spacing: 14) {
            ForEach(themes) { theme in
                QuizPosterCell(
                    theme: theme,
                    posterURL: store.posters[theme.titleId],
                    isSelected: selectedTitleId == theme.titleId
                ) {
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    withAnimation(.easeOut(duration: 0.18)) {
                        selectedTitleId = theme.titleId
                    }
                    onSelect?()
                }
                .task {
                    // Resolve posters lazily for tiles scrolled into view that
                    // the background prefetch hasn't reached yet.
                    if store.posters[theme.titleId] == nil {
                        await store.loadPosters(for: [theme.titleId])
                    }
                }
            }
        }
    }

    private var loadingRow: some View {
        HStack {
            Spacer()
            ProgressView().tint(TwoWatchTheme.brandPrimary).padding(.vertical, 28)
            Spacer()
        }
    }

    private func errorRow(_ message: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "wifi.exclamationmark")
                .font(.system(size: 26, weight: .bold))
                .foregroundStyle(TwoWatchTheme.textMuted)
            Text("Impossibile caricare i titoli")
                .font(.subheadline.weight(.bold))
                .foregroundStyle(TwoWatchTheme.textPrimary)
            Text(message)
                .font(.caption)
                .foregroundStyle(TwoWatchTheme.textSecondary)
                .multilineTextAlignment(.center)
            Button {
                Task { await store.load() }
            } label: {
                Label("Riprova", systemImage: "arrow.clockwise")
                    .font(.subheadline.weight(.bold))
            }
            .buttonStyle(.bordered)
            .tint(TwoWatchTheme.brandPrimary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 24)
    }
}

// MARK: - Poster cell

/// A single vetrina tile: poster (or a deterministic coloured plate with the
/// title while the poster resolves), a selection ring, and the title below.
struct QuizPosterCell: View {
    let theme: QuizTheme
    let posterURL: URL?
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 6) {
                ZStack(alignment: .topTrailing) {
                    poster
                        .aspectRatio(2.0 / 3.0, contentMode: .fit)
                        .frame(maxWidth: .infinity)
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .stroke(
                                    isSelected ? TwoWatchTheme.brandPrimary : TwoWatchTheme.border,
                                    lineWidth: isSelected ? 2.4 : 1
                                )
                        )

                    if isSelected {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.headline)
                            .foregroundStyle(.white, TwoWatchTheme.brandPrimary)
                            .padding(6)
                    }
                }

                Text(theme.title)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(isSelected ? TwoWatchTheme.brandPrimary : TwoWatchTheme.textSecondary)
                    .lineLimit(2)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .frame(minHeight: 28, alignment: .top)
            }
        }
        .buttonStyle(QuizPressableStyle())
        .accessibilityLabel("\(theme.title). \(theme.mediaType == .tv ? "Serie TV" : "Film").\(isSelected ? " Selezionato." : "")")
        .accessibilityAddTraits(isSelected ? [.isSelected, .isButton] : .isButton)
    }

    @ViewBuilder
    private var poster: some View {
        if let posterURL {
            CachedAsyncImage(url: posterURL) { phase in
                switch phase {
                case let .success(image):
                    image.resizable().scaledToFill()
                case .empty:
                    plate.overlay(ProgressView().tint(.white.opacity(0.8)))
                default:
                    plate
                }
            }
        } else {
            plate
        }
    }

    /// Deterministic coloured plate (from the titleId) showing the title and a
    /// media-type glyph — keeps the grid legible before posters resolve.
    private var plate: some View {
        ZStack {
            LinearGradient(
                colors: plateColors,
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            VStack(spacing: 6) {
                Image(systemName: theme.mediaType == .tv ? "tv.fill" : "film.fill")
                    .font(.title3.weight(.bold))
                    .foregroundStyle(.white.opacity(0.85))
                Text(theme.title)
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(.white)
                    .lineLimit(3)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 6)
            }
        }
    }

    private var plateColors: [Color] {
        let palette: [(Color, Color)] = [
            (Color(hex: "#6A1B9A"), Color(hex: "#311B92")),
            (Color(hex: "#AD1457"), Color(hex: "#4A0E2E")),
            (Color(hex: "#1565C0"), Color(hex: "#0A2540")),
            (Color(hex: "#00695C"), Color(hex: "#08302B")),
            (Color(hex: "#E65100"), Color(hex: "#4A1D00")),
            (Color(hex: "#37474F"), Color(hex: "#161E22"))
        ]
        let idx = abs(theme.titleId.hashValue) % palette.count
        let pair = palette[idx]
        return [pair.0, pair.1]
    }
}
