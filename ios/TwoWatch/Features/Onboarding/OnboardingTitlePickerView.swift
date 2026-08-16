import SwiftUI

// MARK: - Modo

/// I due step "a griglia" dell'onboarding v2. Stessa meccanica (tap sui
/// poster), copy e destinazione diverse: il primo riempie la watchlist, il
/// secondo la libreria del profilo. È la distinzione watchlist/Visti spiegata
/// facendola, invece che a parole in uno slide.
enum OnboardingPickerMode {
    case watchlist
    case library

    var title: String {
        switch self {
        case .watchlist: return String(localized: "Salva 3 cose che vuoi vedere")
        case .library: return String(localized: "E cosa hai già visto?")
        }
    }

    var subtitle: String {
        switch self {
        case .watchlist:
            return String(localized: "La watchlist è solo quello che vuoi vedere: da qui Somto ti dice cosa guardare stasera.")
        case .library:
            return String(localized: "Finisce nella libreria del tuo profilo, sotto «Visti».")
        }
    }

    /// Solo la watchlist è obbligatoria: senza non abbiamo niente da mostrare
    /// in Home al primo avvio.
    var isSkippable: Bool {
        switch self {
        case .watchlist: return false
        case .library: return true
        }
    }

    var minimumCount: Int {
        switch self {
        case .watchlist: return 3
        case .library: return 1
        }
    }
}

// MARK: - View

/// Step a griglia dell'onboarding: ricerca + popolari, tap per selezionare.
/// La scrittura la fa il coordinatore (`OnboardingFlowView`), così la view
/// resta la stessa per entrambi i modi.
struct OnboardingTitlePickerView: View {
    let mode: OnboardingPickerMode
    let titleRepository: TitleRepository
    var onConfirm: (_ selectedTitleIds: [String]) -> Void
    var onSkip: () -> Void

    @State private var model: OnboardingPickerModel

    init(
        mode: OnboardingPickerMode,
        titleRepository: TitleRepository,
        onConfirm: @escaping (_ selectedTitleIds: [String]) -> Void,
        onSkip: @escaping () -> Void
    ) {
        self.mode = mode
        self.titleRepository = titleRepository
        self.onConfirm = onConfirm
        self.onSkip = onSkip
        _model = State(initialValue: OnboardingPickerModel(
            titleRepository: titleRepository,
            minimumCount: mode.minimumCount
        ))
    }

    var body: some View {
        ZStack {
            TwoWatchBackground()

            VStack(spacing: 0) {
                content
            }
        }
        .safeAreaInset(edge: .bottom) {
            OnboardingPickerFooter(
                selectedCount: model.selectedTitleIds.count,
                minimumCount: mode.minimumCount,
                canContinue: model.canContinue,
                isSkippable: mode.isSkippable,
                onContinue: confirmSelection,
                onSkip: onSkip
            )
        }
        .task {
            await model.loadInitialIfNeeded()
        }
    }

    @ViewBuilder
    private var content: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                header
                searchField
                resultsSection
            }
            .padding(.horizontal, 20)
            .padding(.top, 16)
            .padding(.bottom, 8)
        }
        .scrollDismissesKeyboard(.interactively)
    }

    // MARK: Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(mode.title)
                .font(.largeTitle.weight(.bold))
                .fontDesign(.rounded)
                .foregroundStyle(TwoWatchTheme.textPrimary)
                .fixedSize(horizontal: false, vertical: true)

            Text(mode.subtitle)
                .font(.subheadline)
                .foregroundStyle(TwoWatchTheme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: Search field

    private var searchField: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(TwoWatchTheme.textMuted)

            TextField(
                "",
                text: Binding(
                    get: { model.query },
                    set: { model.updateQuery($0) }
                ),
                prompt: Text("Cerca un film o una serie")
                    .foregroundColor(TwoWatchTheme.textMuted)
            )
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .foregroundStyle(TwoWatchTheme.textPrimary)
            .submitLabel(.search)

            if !model.query.isEmpty {
                Button {
                    model.clearQuery()
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.subheadline)
                        .foregroundStyle(TwoWatchTheme.textMuted)
                }
                .accessibilityLabel("Cancella ricerca")
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(TwoWatchTheme.panelStrong)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(TwoWatchTheme.border, lineWidth: 1)
        )
    }

    // MARK: Results

    @ViewBuilder
    private var resultsSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(model.isSearching ? "Risultati" : "Popolari su Somto")
                .font(.headline.weight(.semibold))
                .foregroundStyle(TwoWatchTheme.textPrimary)

            switch model.phase {
            case .loading:
                loadingState
            case .empty:
                emptyState
            case .error:
                errorState
            case .loaded:
                grid
            }
        }
    }

    private var loadingState: some View {
        VStack(spacing: 12) {
            ProgressView()
                .tint(TwoWatchTheme.brandPrimary)
            Text("Carico i titoli")
                .font(.footnote)
                .foregroundStyle(TwoWatchTheme.textSecondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 48)
    }

    private var emptyState: some View {
        EmptyStateView(
            title: model.isSearching ? "Nessun titolo trovato" : "Catalogo non disponibile",
            message: model.isSearching
                ? "Prova con un altro nome o controlla l'ortografia."
                : "Non riusciamo a caricare i titoli popolari. Puoi cercarli a mano qui sopra.",
            systemImage: "film.stack"
        )
    }

    private var errorState: some View {
        EmptyStateView(
            title: "Qualcosa e' andato storto",
            message: "Non siamo riusciti a caricare i titoli. Riprova tra poco.",
            systemImage: "wifi.exclamationmark",
            actionTitle: "Riprova",
            action: { Task { await model.retry() } }
        )
    }

    private var grid: some View {
        LazyVGrid(columns: OnboardingPickerModel.gridColumns, spacing: 18) {
            ForEach(model.results) { title in
                OnboardingPickerPosterCell(
                    title: title,
                    isSelected: model.isSelected(title),
                    canSelectMore: model.canSelectMore,
                    onTap: { model.toggle(title) }
                )
            }
        }
        .animation(.easeOut(duration: 0.2), value: model.results)
    }

    // MARK: Actions

    private func confirmSelection() {
        guard model.canContinue else { return }
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        onConfirm(model.selectedTitleIds)
    }
}

// MARK: - View Model

@Observable
@MainActor
fileprivate final class OnboardingPickerModel {
    enum Phase: Equatable {
        case loading
        case loaded
        case empty
        case error
    }

    static let maximumCount = 12

    static let gridColumns: [GridItem] = [
        GridItem(.flexible(), spacing: 14),
        GridItem(.flexible(), spacing: 14),
        GridItem(.flexible(), spacing: 14)
    ]

    private let titleRepository: TitleRepository
    private let minimumCount: Int

    var query: String = ""
    var phase: Phase = .loading
    var popularTitles: [Title] = []
    var searchResults: [Title] = []
    private(set) var selectedOrder: [String] = []
    private(set) var selectedTitles: [String: Title] = [:]

    private var hasLoadedPopular = false
    private var searchTask: Task<Void, Never>?

    init(titleRepository: TitleRepository, minimumCount: Int) {
        self.titleRepository = titleRepository
        self.minimumCount = minimumCount
    }

    // MARK: Derived state

    var isSearching: Bool {
        !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var results: [Title] {
        isSearching ? searchResults : popularTitles
    }

    var selectedTitleIds: [String] {
        selectedOrder
    }

    var canSelectMore: Bool {
        selectedOrder.count < Self.maximumCount
    }

    var canContinue: Bool {
        selectedOrder.count >= minimumCount
    }

    func isSelected(_ title: Title) -> Bool {
        selectedTitles[title.id] != nil
    }

    // MARK: Loading

    func loadInitialIfNeeded() async {
        guard !hasLoadedPopular else { return }
        await loadPopular()
    }

    func retry() async {
        if isSearching {
            await runSearch(for: query)
        } else {
            await loadPopular()
        }
    }

    private func loadPopular() async {
        phase = .loading
        do {
            let titles = try await titleRepository.listPopularTitles(limit: 24)
            popularTitles = titles
            hasLoadedPopular = true
            phase = titles.isEmpty ? .empty : .loaded
        } catch {
            phase = .error
        }
    }

    // MARK: Search

    func updateQuery(_ newValue: String) {
        query = newValue
        searchTask?.cancel()

        let trimmed = newValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            searchResults = []
            phase = popularTitles.isEmpty ? .empty : .loaded
            return
        }

        phase = .loading
        searchTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            await self?.runSearch(for: trimmed)
        }
    }

    func clearQuery() {
        searchTask?.cancel()
        query = ""
        searchResults = []
        phase = popularTitles.isEmpty ? .empty : .loaded
    }

    private func runSearch(for rawQuery: String) async {
        let trimmed = rawQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        phase = .loading
        do {
            let titles = try await titleRepository.searchTitles(trimmed, limit: 24)
            guard !Task.isCancelled else { return }
            searchResults = titles
            phase = titles.isEmpty ? .empty : .loaded
        } catch {
            guard !Task.isCancelled else { return }
            phase = .error
        }
    }

    // MARK: Selection

    func toggle(_ title: Title) {
        if selectedTitles[title.id] != nil {
            selectedTitles[title.id] = nil
            selectedOrder.removeAll { $0 == title.id }
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
        } else {
            guard canSelectMore else {
                UINotificationFeedbackGenerator().notificationOccurred(.warning)
                return
            }
            selectedTitles[title.id] = title
            selectedOrder.append(title.id)
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        }
    }
}

// MARK: - Poster Cell

fileprivate struct OnboardingPickerPosterCell: View {
    let title: Title
    let isSelected: Bool
    let canSelectMore: Bool
    let onTap: () -> Void

    private var isDimmed: Bool {
        !isSelected && !canSelectMore
    }

    var body: some View {
        Button(action: onTap) {
            VStack(alignment: .leading, spacing: 8) {
                posterArtwork

                Text(title.name)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)

                Text(title.subtitle)
                    .font(.caption2)
                    .foregroundStyle(TwoWatchTheme.textMuted)
                    .lineLimit(1)
            }
        }
        .buttonStyle(.plain)
        .opacity(isDimmed ? 0.45 : 1)
        .animation(.easeOut(duration: 0.2), value: isSelected)
        .accessibilityLabel(title.name)
        .accessibilityValue(isSelected ? "Selezionato" : "Non selezionato")
        .accessibilityHint(isSelected ? String(localized: "Tocca per rimuovere") : String(localized: "Tocca per aggiungere"))
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
    }

    private var posterArtwork: some View {
        ZStack(alignment: .topTrailing) {
            poster
                .aspectRatio(2.0 / 3.0, contentMode: .fit)
                .frame(maxWidth: .infinity)
                .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .stroke(
                            isSelected ? TwoWatchTheme.brandPrimary : TwoWatchTheme.border,
                            lineWidth: isSelected ? 3 : 1
                        )
                }
                .overlay {
                    if isSelected {
                        RoundedRectangle(cornerRadius: 18, style: .continuous)
                            .fill(TwoWatchTheme.brandPrimary.opacity(0.16))
                    }
                }
                .shadow(color: .black.opacity(0.28), radius: 14, y: 8)

            if isSelected {
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 22, weight: .bold))
                    .foregroundStyle(.white, TwoWatchTheme.brandPrimary)
                    .padding(7)
                    .transition(.scale.combined(with: .opacity))
            }
        }
    }

    /// Self-sizing poster: fills the flexible grid column and keeps a 2:3 ratio.
    /// We render the artwork inline (instead of `PosterImageView`, which forces a
    /// fixed frame) so posters stretch correctly across device widths.
    @ViewBuilder
    private var poster: some View {
        if let url = title.posterPath {
            CachedAsyncImage(url: url) { phase in
                switch phase {
                case let .success(image):
                    image.resizable().scaledToFill()
                case .failure:
                    posterPlaceholder
                case .empty:
                    ZStack {
                        TwoWatchTheme.panelStrong
                        ProgressView().tint(TwoWatchTheme.textSecondary)
                    }
                @unknown default:
                    posterPlaceholder
                }
            }
        } else {
            posterPlaceholder
        }
    }

    private var posterPlaceholder: some View {
        ZStack {
            TwoWatchTheme.brandGradient
            Image(systemName: "film.stack.fill")
                .font(.system(size: 26, weight: .semibold))
                .foregroundStyle(.white.opacity(0.82))
        }
    }
}

// MARK: - Footer (sticky CTA)

fileprivate struct OnboardingPickerFooter: View {
    let selectedCount: Int
    let minimumCount: Int
    let canContinue: Bool
    let isSkippable: Bool
    let onContinue: () -> Void
    let onSkip: () -> Void

    var body: some View {
        VStack(spacing: 12) {
            counterRow

            Button("Continua", action: onContinue)
                .buttonStyle(PrimaryButtonStyle())
                .disabled(!canContinue)
                .opacity(canContinue ? 1 : 0.5)
                .accessibilityHint(canContinue
                    ? "Conferma i titoli scelti"
                    : "Scegli almeno \(minimumCount) titoli per continuare")

            if isSkippable {
                Button("Salta per ora", action: onSkip)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(TwoWatchTheme.textSecondary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
                    .accessibilityHint("Salta questo passaggio")
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 14)
        .padding(.bottom, 10)
        .background(
            TwoWatchTheme.background
                .opacity(0.92)
                .background(.ultraThinMaterial)
                .ignoresSafeArea()
        )
        .overlay(alignment: .top) {
            Rectangle()
                .fill(TwoWatchTheme.border)
                .frame(height: 1)
        }
    }

    /// Contatore come progresso, non come muro: sotto la soglia dice quanto
    /// manca, sopra conferma e basta.
    private var counterRow: some View {
        HStack(spacing: 8) {
            Image(systemName: canContinue ? "checkmark.seal.fill" : "sparkles")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(canContinue ? TwoWatchTheme.success : TwoWatchTheme.brandPrimary)

            Text(progressMessage)
                .font(.footnote.weight(.medium))
                .foregroundStyle(TwoWatchTheme.textSecondary)

            Spacer(minLength: 8)

            Text("\(selectedCount)")
                .font(.subheadline.weight(.bold))
                .monospacedDigit()
                .foregroundStyle(canContinue ? TwoWatchTheme.success : TwoWatchTheme.textPrimary)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(
            Capsule(style: .continuous)
                .fill(TwoWatchTheme.panelStrong)
        )
        .overlay(
            Capsule(style: .continuous)
                .stroke(TwoWatchTheme.border, lineWidth: 1)
        )
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(selectedCount) titoli selezionati")
    }

    private var progressMessage: String {
        if canContinue {
            return String(localized: "Ottimo, puoi continuare")
        }
        let missing = minimumCount - selectedCount
        return String(localized: "Ancora \(missing) per iniziare")
    }
}

// MARK: - Preview

#if DEBUG
#Preview("Picker — watchlist") {
    OnboardingTitlePickerView(
        mode: .watchlist,
        titleRepository: TwoWatchPreview.container.titleRepository,
        onConfirm: { ids in print("watchlist: \(ids)") },
        onSkip: {}
    )
}

#Preview("Picker — libreria") {
    OnboardingTitlePickerView(
        mode: .library,
        titleRepository: TwoWatchPreview.container.titleRepository,
        onConfirm: { ids in print("libreria: \(ids)") },
        onSkip: {}
    )
}
#endif
