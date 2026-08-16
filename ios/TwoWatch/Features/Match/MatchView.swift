import Observation
import SwiftUI

@Observable
@MainActor
final class MatchViewModel {
    private let repository: MatchRepository
    private let analytics: AnalyticsLogging
    @ObservationIgnored private var shownIDs: Set<String> = []

    var queue: [MatchCandidate] = []
    var isLoading = false
    var isSaving = false
    var errorMessage: String?

    init(repository: MatchRepository, analytics: AnalyticsLogging = NoopAnalyticsLogger()) {
        self.repository = repository
        self.analytics = analytics
    }

    var currentCandidate: MatchCandidate? {
        queue.first
    }

    func load(userID: String) async {
        guard queue.isEmpty else { return }
        await reload(userID: userID)
    }

    func reload(userID: String) async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        do {
            queue = try await repository.fetchQueue(excluding: Array(shownIDs))
            analytics.log(AnalyticsEvent.matchDeckLoaded, ["count": queue.count])
            if let currentCandidate {
                try await repository.markShown(userID: userID, candidate: currentCandidate)
                shownIDs.insert(currentCandidate.id)
            }
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }

    func apply(_ action: MatchAction, userID: String) async {
        guard !isSaving, let currentCandidate else { return }
        isSaving = true
        errorMessage = nil
        defer { isSaving = false }

        analytics.log(AnalyticsEvent.matchAction, [
            "action": action.rawValue,
            "title_id": currentCandidate.id
        ])

        do {
            try await repository.saveFeedback(userID: userID, candidate: currentCandidate, action: action)

            if !queue.isEmpty {
                queue.removeFirst()
            }

            if queue.count < 4 {
                let extra = try await repository.fetchQueue(excluding: Array(shownIDs.union(queue.map(\.id))))
                let merged = queue + extra
                queue = MatchRepository.diversify(merged)
            }

            if let nextCandidate = queue.first {
                try await repository.markShown(userID: userID, candidate: nextCandidate)
                shownIDs.insert(nextCandidate.id)
            }
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }
}

struct MatchView: View {
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore
    private let disablesAutomaticLoading: Bool

    @State private var viewModel: MatchViewModel
    @State private var dragOffset: CGSize = .zero
    @State private var isShowingInfoSheet = false
    private let hintService: MatchHintService

    init(container: AppContainer, session: SessionStore, shell: AppShellStore) {
        self.container = container
        self.session = session
        self.shell = shell
        disablesAutomaticLoading = false
        hintService = MatchHintService()
        _viewModel = State(initialValue: MatchViewModel(
            repository: container.matchRepository,
            analytics: container.analytics
        ))
    }

#if DEBUG
    init(container: AppContainer, session: SessionStore, shell: AppShellStore, previewViewModel: MatchViewModel) {
        self.container = container
        self.session = session
        self.shell = shell
        disablesAutomaticLoading = true
        hintService = MatchHintService(defaults: UserDefaults(suiteName: "match-preview") ?? .standard)
        _viewModel = State(initialValue: previewViewModel)
    }
#endif

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                TwoWatchBackground()
                    .ignoresSafeArea()

                if !session.isAuthenticated {
                    unauthenticatedState
                        .padding(20)
                } else {
                    content(geometry: geometry)
                }

                if viewModel.isSaving {
                    HStack(spacing: 10) {
                        ProgressView()
                            .tint(TwoWatchTheme.textPrimary)
                        Text("Salvo la scelta…")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(TwoWatchTheme.textPrimary)
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                    .background(.ultraThinMaterial, in: Capsule())
                    .overlay(Capsule().stroke(TwoWatchTheme.border, lineWidth: 1))
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("Salvataggio scelta in corso")
                    .transition(.opacity.combined(with: .scale(scale: 0.96)))
                }
            }
        }
        .toolbar(.hidden, for: .navigationBar)
        .task(id: session.firebaseUser?.uid) {
            guard !disablesAutomaticLoading else { return }
            if let userID = session.firebaseUser?.uid {
                dragOffset = .zero
                await viewModel.load(userID: userID)
            }
        }
        .refreshable {
            guard !disablesAutomaticLoading else { return }
            if let userID = session.firebaseUser?.uid {
                dragOffset = .zero
                await viewModel.reload(userID: userID)
            }
        }
        .sheet(isPresented: $isShowingInfoSheet, onDismiss: {
            hintService.markHintSeen()
        }) {
            MatchInfoSheet()
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
        .onChange(of: didRenderDeck) { _, rendered in
            guard rendered, !disablesAutomaticLoading, hintService.shouldShowHint, !isShowingInfoSheet else { return }
            isShowingInfoSheet = true
        }
    }

    /// True the first time the deck has real candidates to show (not loading,
    /// no error, at least one card) — the trigger point for the one-time
    /// coach-mark. Deliberately excludes the error/empty states.
    private var didRenderDeck: Bool {
        session.isAuthenticated && !viewModel.isLoading && viewModel.errorMessage == nil && !viewModel.queue.isEmpty
    }

    private var unauthenticatedState: some View {
        EmptyStateView(
            title: "Accedi per usare Match",
            message: "La coda personalizzata si basa sui segnali privati del tuo profilo.",
            systemImage: "hand.draw.fill",
            actionTitle: "Accedi"
        ) {
            shell.presentAuth()
        }
    }

    private func content(geometry: GeometryProxy) -> some View {
        VStack(spacing: 14) {
            Spacer().frame(height: 26)
            HStack {
                Spacer()
                Button {
                    isShowingInfoSheet = true
                } label: {
                    Image(systemName: "info.circle")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                        .frame(width: 32, height: 32)
                        .background(.ultraThinMaterial, in: Circle())
                        .overlay(Circle().stroke(Color.white.opacity(0.3), lineWidth: 0.5))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Info su Match")
            }
            .padding(.horizontal, 20)

            if let errorMessage = viewModel.errorMessage {
                GlassCard {
                    Text(errorMessage)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Color.red)
                }
                .padding(.horizontal, 20)
            }

            ZStack {
                if let userID = session.firebaseUser?.uid, !viewModel.queue.isEmpty {
                    MatchDeckView(
                        candidates: viewModel.queue,
                        dragOffset: $dragOffset,
                        availableHeight: geometry.size.height,
                        isSaving: viewModel.isSaving
                    ) { action in
                        await perform(action, userID: userID)
                    }
                    .padding(.horizontal, 16)
                } else if viewModel.isLoading {
                    ProgressView("Sto preparando la tua coda Match…")
                        .tint(TwoWatchTheme.textPrimary)
                } else {
                    EmptyStateView(
                        title: "Coda esaurita per ora",
                        message: "Hai finito i titoli disponibili per questo passaggio. Puoi ricaricare o tornare più tardi dopo nuovi segnali.",
                        systemImage: "sparkles.rectangle.stack.fill",
                        actionTitle: "Ricarica"
                    ) {
                        if let userID = session.firebaseUser?.uid {
                            Task { await viewModel.reload(userID: userID) }
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            if let userID = session.firebaseUser?.uid, !viewModel.queue.isEmpty {
                MatchActionBar(isDisabled: viewModel.isSaving) { action in
                    Task { await perform(action, userID: userID) }
                }
                .padding(.horizontal, 20)
                .padding(.bottom, max(geometry.safeAreaInsets.bottom, 10))
            }
        }
        .padding(.top, 8)
    }

    private func perform(_ action: MatchAction, userID: String) async {
        guard !viewModel.isSaving else { return }

        withAnimation(.spring(response: 0.28, dampingFraction: 0.86)) {
            dragOffset = .zero
        }
        await viewModel.apply(action, userID: userID)
    }
}

#if DEBUG
private struct MatchViewRuntimePreview: View {
    let session: SessionStore
    let viewModel: MatchViewModel
    @State private var shell = TwoWatchPreview.shell(selectedTab: .community)

    var body: some View {
        TabView(selection: $shell.selectedTab) {
            Color.clear
                .tabItem { Label("Home", systemImage: "house.fill") }
                .tag(AppTab.home)

            NavigationStack {
                MatchView(
                    container: TwoWatchPreview.container,
                    session: session,
                    shell: shell,
                    previewViewModel: viewModel
                )
            }
            .brandChromePill(shell: shell)
            .tabItem { Label("Community", systemImage: "person.2.fill") }
            .tag(AppTab.community)

            Color.clear
                .tabItem { Label("Watchlist", systemImage: "bookmark.fill") }
                .tag(AppTab.watchlist)

            Color.clear
                .tabItem { Label("Quiz", systemImage: "questionmark.circle.fill") }
                .tag(AppTab.quiz)

            Color.clear
                .tabItem { Label("Profilo", systemImage: "person.crop.circle.fill") }
                .tag(AppTab.profile)
        }
        .toolbarBackground(.visible, for: .tabBar)
        .toolbarBackground(TwoWatchTheme.tabMaterial, for: .tabBar)
        .toolbarColorScheme(.dark, for: .tabBar)
    }
}

#Preview("Match", traits: .fixedLayout(width: 393, height: 852)) {
    MatchViewRuntimePreview(
        session: TwoWatchPreview.session(),
        viewModel: TwoWatchPreview.matchViewModel()
    )
}
#endif

private struct MatchDeckView: View {
    let candidates: [MatchCandidate]
    @Binding var dragOffset: CGSize
    let availableHeight: CGFloat
    let isSaving: Bool
    let onAction: @MainActor (MatchAction) async -> Void

    var body: some View {
        GeometryReader { geometry in
            let cardWidth = min(geometry.size.width - 8, 390)
            let maxCardHeight = min(availableHeight * 0.74, geometry.size.height - 8)
            let cardHeight = max(420, maxCardHeight)

            ZStack {
                ForEach(Array(candidates.prefix(3).enumerated()), id: \.element.id) { index, candidate in
                    let isTopCard = index == 0

                    MatchCandidateCard(
                        candidate: candidate,
                        dragOffset: isTopCard ? dragOffset : .zero
                    )
                    .frame(width: cardWidth, height: cardHeight)
                    .scaleEffect(isTopCard ? 1 : 1 - (CGFloat(index) * 0.04))
                    .offset(y: isTopCard ? 0 : CGFloat(index) * 12)
                    .brightness(isTopCard ? 0 : -0.03 * Double(index))
                    .zIndex(Double(candidates.count - index))
                    .allowsHitTesting(isTopCard && !isSaving)
                    .gesture(isTopCard ? dragGesture(cardWidth: cardWidth) : nil)
                    .animation(.spring(response: 0.34, dampingFraction: 0.84), value: candidates)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func dragGesture(cardWidth: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 8)
            .onChanged { value in
                guard !isSaving else { return }
                dragOffset = value.translation
            }
            .onEnded { value in
                guard !isSaving else { return }

                let prediction = value.predictedEndTranslation
                let horizontal = prediction.width
                let vertical = prediction.height
                let horizontalThreshold = cardWidth * 0.34
                let superlikeThreshold = -140.0

                if vertical < superlikeThreshold, abs(horizontal) < horizontalThreshold {
                    fling(to: CGSize(width: 0, height: -cardWidth), action: .superlike)
                } else if horizontal > horizontalThreshold {
                    fling(to: CGSize(width: cardWidth, height: 90), action: .like)
                } else if horizontal < -horizontalThreshold {
                    fling(to: CGSize(width: -cardWidth, height: 90), action: .dislike)
                } else {
                    withAnimation(.spring(response: 0.32, dampingFraction: 0.78)) {
                        dragOffset = .zero
                    }
                }
            }
    }

    private func fling(to target: CGSize, action: MatchAction) {
        // Feedback aptico al confermato swipe (prima dell'animazione di uscita carta).
        let hapticStyle: UIImpactFeedbackGenerator.FeedbackStyle = action == .superlike ? .rigid : .soft
        UIImpactFeedbackGenerator(style: hapticStyle).impactOccurred()

        withAnimation(.spring(response: 0.22, dampingFraction: 0.82)) {
            dragOffset = target
        }

        Task {
            try? await Task.sleep(for: .milliseconds(170))
            await onAction(action)
        }
    }
}

private struct MatchCandidateCard: View {
    let candidate: MatchCandidate
    let dragOffset: CGSize

    // Titolo carta: dimensione di default identica (28 pt), scala con Dynamic Type.
    @ScaledMetric(relativeTo: .largeTitle) private var cardTitleSize: CGFloat = 28

    private var cardRotation: Double {
        Double(dragOffset.width / 18)
    }

    private var overlayState: MatchSwipeOverlay.State? {
        if dragOffset.height < -110, abs(dragOffset.width) < 110 {
            return .superlike
        }
        if dragOffset.width > 48 {
            return .like
        }
        if dragOffset.width < -48 {
            return .dislike
        }
        return nil
    }

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            CachedAsyncImage(url: candidate.posterURL) { phase in
                switch phase {
                case let .success(image):
                    image
                        .resizable()
                        .scaledToFill()
                case .failure:
                    placeholder
                case .empty:
                    ZStack {
                        RoundedRectangle(cornerRadius: 30, style: .continuous)
                            .fill(TwoWatchTheme.panelStrong)
                        ProgressView()
                            .tint(TwoWatchTheme.textSecondary)
                    }
                @unknown default:
                    placeholder
                }
            }
            .overlay(cardChrome)
            .clipShape(RoundedRectangle(cornerRadius: 30, style: .continuous))
            // La locandina è decorativa: titolo/cast/generi leggibili nel cardInfo sottostante.
            .accessibilityHidden(true)

            cardInfo
                .padding(18)

            if let overlayState {
                MatchSwipeOverlay(state: overlayState, intensity: overlayOpacity)
                    .padding(20)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: overlayAlignment(for: overlayState))
            }
        }
        .background(
            RoundedRectangle(cornerRadius: 30, style: .continuous)
                .fill(TwoWatchTheme.backgroundSecondary)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 30, style: .continuous)
                .stroke(TwoWatchTheme.border, lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.32), radius: 26, y: 14)
        .rotationEffect(.degrees(cardRotation))
        .offset(dragOffset)
    }

    private var overlayOpacity: Double {
        min(1, max(abs(dragOffset.width) / 120, abs(dragOffset.height) / 120))
    }

    private var resolvedGenres: [String] {
        GenreDisplay.labels(from: candidate.genres)
    }

    private var cardChrome: some View {
        LinearGradient(
            colors: [
                .clear,
                .clear,
                Color.black.opacity(0.18),
                Color.black.opacity(0.82)
            ],
            startPoint: .top,
            endPoint: .bottom
        )
    }

    private var cardInfo: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Text(candidate.subtitle)
                    .font(.caption.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(Color.black.opacity(0.26), in: Capsule())

                // Niente "★ 0.0 community" su titoli senza voti (sembrava valutato 0).
                if candidate.ratingCount > 0 {
                    communityBadge
                }
            }

            Text(candidate.name)
                .font(.system(size: cardTitleSize, weight: .black, design: .rounded))
                .foregroundStyle(TwoWatchTheme.textPrimary)
                .lineLimit(2)

            if !resolvedGenres.isEmpty {
                Text(resolvedGenres.prefix(2).joined(separator: " • "))
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(TwoWatchTheme.textPrimary.opacity(0.92))
                    .lineLimit(1)
            }

            if !candidate.cast.isEmpty {
                Text(candidate.cast.prefix(2).joined(separator: " • "))
                    .font(.caption.weight(.medium))
                    .foregroundStyle(TwoWatchTheme.textSecondary)
                    .lineLimit(1)
            }

            Text(candidate.overview)
                .font(.caption)
                .foregroundStyle(TwoWatchTheme.textPrimary.opacity(0.9))
                .lineLimit(3)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var communityBadge: some View {
        HStack(spacing: 6) {
            Image(systemName: "star.fill")
                .font(.caption2.weight(.bold))
                .accessibilityHidden(true) // decorativa: il testo affiancato fornisce il valore
            Text(String(format: "%.1f", candidate.ratingAvg))
                .font(.caption.weight(.bold))
            Text("community")
                .font(.caption2.weight(.medium))
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(Color.black.opacity(0.26), in: Capsule())
    }

    private func overlayAlignment(for state: MatchSwipeOverlay.State) -> Alignment {
        switch state {
        case .dislike:
            return .topLeading
        case .like:
            return .topTrailing
        case .superlike:
            return .top
        }
    }

    private var placeholder: some View {
        ZStack {
            TwoWatchTheme.brandGradient
            Image(systemName: "film.stack.fill")
                .font(.system(size: 42, weight: .bold))
                .foregroundStyle(.white.opacity(0.86))
        }
    }
}

private struct MatchSwipeOverlay: View {
    enum State {
        case dislike
        case like
        case superlike
    }

    let state: State
    let intensity: Double

    // Etichetta swipe: default 26 pt, scala con Dynamic Type.
    @ScaledMetric(relativeTo: .title) private var overlayFontSize: CGFloat = 26

    var body: some View {
        Text(title)
            .font(.system(size: overlayFontSize, weight: .black, design: .rounded))
            .kerning(1.2)
            .foregroundStyle(color)
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(Color.black.opacity(0.2), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(color, lineWidth: 3)
            )
            .rotationEffect(.degrees(rotation))
            .opacity(intensity)
    }

    private var title: String {
        switch state {
        case .dislike:
            return "NOPE"
        case .like:
            return "LIKE"
        case .superlike:
            return "SUPERLIKE"
        }
    }

    private var color: Color {
        switch state {
        case .dislike:
            return TwoWatchTheme.warning
        case .like:
            return TwoWatchTheme.success
        case .superlike:
            return TwoWatchTheme.accent
        }
    }

    private var rotation: Double {
        switch state {
        case .dislike:
            return -12
        case .like:
            return 12
        case .superlike:
            return 0
        }
    }
}

private struct MatchActionBar: View {
    let isDisabled: Bool
    let onAction: (MatchAction) -> Void

    var body: some View {
        HStack(spacing: 14) {
            actionButton(action: .dislike, icon: "xmark", tint: TwoWatchTheme.warning, size: 58,
                         label: "Salta", hapticStyle: .soft)
            actionButton(action: .like, icon: "heart.fill", tint: TwoWatchTheme.brandPrimary, size: 58,
                         label: "Mi piace", hapticStyle: .medium)
            actionButton(action: .superlike, icon: "star.fill", tint: TwoWatchTheme.accent, size: 50,
                         label: "Super like", hapticStyle: .rigid)
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 10)
        .padding(.vertical, 14)
        .background(.ultraThinMaterial, in: Capsule())
        .overlay(
            Capsule()
                .stroke(TwoWatchTheme.border, lineWidth: 1)
        )
    }

    private func actionButton(
        action: MatchAction,
        icon: String,
        tint: Color,
        size: CGFloat,
        label: String,
        hapticStyle: UIImpactFeedbackGenerator.FeedbackStyle
    ) -> some View {
        Button {
            // Feedback aptico al tocco del pulsante azione Match.
            UIImpactFeedbackGenerator(style: hapticStyle).impactOccurred()
            onAction(action)
        } label: {
            Image(systemName: icon)
                .font(.system(size: size * 0.32, weight: .black))
                .foregroundStyle(tint)
                .frame(width: size, height: size)
                .background(Color.black.opacity(0.16), in: Circle())
                .overlay(
                    Circle()
                        .stroke(tint.opacity(0.32), lineWidth: 1)
                )
        }
        .buttonStyle(.plain)
        .disabled(isDisabled)
        .accessibilityLabel(label)
    }
}

private struct MatchInfoSheet: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Text("Match: decidi cosa guardare in 10 secondi")
                    .font(.title2.weight(.black))
                    .foregroundStyle(TwoWatchTheme.textPrimary)

                Text("Scorri a sinistra per scartare, a destra per dare like, verso l'alto per un superlike.")
                    .font(.subheadline)
                    .foregroundStyle(TwoWatchTheme.textSecondary)

                HStack(spacing: 10) {
                    introTile(icon: "arrow.left", title: "Sinistra", detail: "Non mi piace")
                    introTile(icon: "arrow.right", title: "Destra", detail: "Like")
                    introTile(icon: "arrow.up", title: "Su", detail: "Superlike")
                }

                VStack(alignment: .leading, spacing: 8) {
                    Text("Like")
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                    Text("Segnale positivo leggero che migliora le proposte successive.")
                        .font(.caption)
                        .foregroundStyle(TwoWatchTheme.textSecondary)

                    Text("Superlike")
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                    Text("Segnale forte, usato per dare priorità alta a titoli e pattern simili.")
                        .font(.caption)
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                }
            }
            .padding(22)
        }
        .background(TwoWatchBackground().ignoresSafeArea())
    }

    private func introTile(icon: String, title: String, detail: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Image(systemName: icon)
                .font(.headline.weight(.black))
                .foregroundStyle(TwoWatchTheme.textPrimary)
            Text(title)
                .font(.caption.weight(.bold))
                .foregroundStyle(TwoWatchTheme.textPrimary)
            Text(detail)
                .font(.caption2)
                .foregroundStyle(TwoWatchTheme.textSecondary)
        }
        .frame(maxWidth: .infinity, minHeight: 84, alignment: .topLeading)
        .padding(12)
        .background(TwoWatchTheme.panel, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}
