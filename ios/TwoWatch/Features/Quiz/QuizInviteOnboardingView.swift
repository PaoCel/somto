import SwiftUI

// MARK: - QuizInviteOnboardingView
//
// "Prima di iniziare" — shown to someone who signed up through an external
// quiz invite. They pick the titles they have seen so the backend can build a
// fair question pool, then start the challenge. Presented as a full-screen
// cover from the Quiz home once `claimExternalInvite` succeeds.

@Observable
@MainActor
final class QuizInviteOnboardingViewModel {
    enum Phase: Equatable {
        case loading
        case picking
        case finalizing
        /// Pool too thin — the invitee should add more titles and retry.
        case needMoreTitles(available: Int)
        case error(String)
    }

    let container: AppContainer
    let session: SessionStore
    let claim: QuizClaimResult

    var phase: Phase = .loading
    /// Titles offered up front (the inviter's seen list).
    var inviterTitles: [Title] = []
    /// Extra titles the invitee searched for and added.
    var addedTitles: [Title] = []
    /// Title ids the invitee has selected (subset of inviter + added).
    var selectedIds: Set<String> = []

    // Search
    var searchQuery: String = ""
    var searchResults: [Title] = []
    var isSearching = false
    private var searchTask: Task<Void, Never>?

    /// Challenge fetched after a successful finalize — handed to the player.
    var readyChallenge: QuizChallenge?

    init(container: AppContainer, session: SessionStore, claim: QuizClaimResult) {
        self.container = container
        self.session = session
        self.claim = claim
    }

    var selectedCount: Int { selectedIds.count }
    var meetsMinimum: Bool { selectedCount >= 2 }

    /// Inviter titles + invitee-added titles, de-duplicated, for the grid.
    var allOfferedTitles: [Title] {
        var seen = Set<String>()
        var out: [Title] = []
        for title in inviterTitles + addedTitles where seen.insert(title.id).inserted {
            out.append(title)
        }
        return out
    }

    func load() async {
        phase = .loading
        let ids = claim.inviterSeenTitleIds
        if ids.isEmpty {
            inviterTitles = []
        } else {
            inviterTitles = (try? await container.titleRepository.listTitles(ids: ids)) ?? []
        }
        // Pre-select the inviter's titles so common ground is the default.
        selectedIds = Set(inviterTitles.map(\.id))
        phase = .picking
    }

    func toggle(_ title: Title) {
        if selectedIds.contains(title.id) {
            selectedIds.remove(title.id)
        } else {
            selectedIds.insert(title.id)
        }
    }

    func updateSearch(_ query: String) {
        searchQuery = query
        searchTask?.cancel()
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 2 else {
            searchResults = []
            isSearching = false
            return
        }
        isSearching = true
        searchTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 280_000_000)
            guard let self, !Task.isCancelled else { return }
            let results = (try? await self.container.titleRepository.searchTitles(trimmed, limit: 20)) ?? []
            guard !Task.isCancelled else { return }
            self.searchResults = results
            self.isSearching = false
        }
    }

    func addFromSearch(_ title: Title) {
        if !addedTitles.contains(where: { $0.id == title.id }),
           !inviterTitles.contains(where: { $0.id == title.id }) {
            addedTitles.append(title)
        }
        selectedIds.insert(title.id)
        searchQuery = ""
        searchResults = []
    }

    func finalize() async {
        guard meetsMinimum else { return }
        phase = .finalizing
        do {
            let result = try await container.quizRepository.finalizeExternalChallenge(
                challengeId: claim.challengeId,
                confirmedTitleIds: Array(selectedIds)
            )
            switch result {
            case .ready:
                let challenge = try await container.quizRepository.fetchChallenge(id: claim.challengeId)
                guard let challenge else {
                    phase = .error(String(localized: "Sfida non trovata. Riprova."))
                    return
                }
                readyChallenge = challenge
            case let .needMoreTitles(available):
                phase = .needMoreTitles(available: available)
            }
        } catch {
            phase = .error(UserFacingError.message(for: error))
        }
    }
}

struct QuizInviteOnboardingView: View {
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore
    let claim: QuizClaimResult
    /// Called when the invitee dismisses without starting (or after the
    /// player closes) so the host can tear the cover down.
    var onClose: () -> Void

    @State private var viewModel: QuizInviteOnboardingViewModel?

    var body: some View {
        NavigationStack {
            Group {
                if let viewModel {
                    content(viewModel)
                } else {
                    loadingState
                }
            }
            .background(TwoWatchTheme.background.ignoresSafeArea())
            .navigationTitle("Prima di iniziare")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Chiudi") { onClose() }
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                        .accessibilityLabel("Chiudi, gioca più tardi")
                }
            }
            .navigationDestination(item: readyChallengeBinding) { challenge in
                QuizPlayView(
                    container: container,
                    session: session,
                    shell: shell,
                    mode: .challenge,
                    challenge: challenge
                )
            }
        }
        .task {
            if viewModel == nil {
                let vm = QuizInviteOnboardingViewModel(container: container, session: session, claim: claim)
                viewModel = vm
                await vm.load()
            }
        }
    }

    /// Drives the push into `QuizPlayView` once `finalize()` resolves.
    private var readyChallengeBinding: Binding<QuizChallenge?> {
        Binding(
            get: { viewModel?.readyChallenge },
            set: { newValue in
                if newValue == nil { viewModel?.readyChallenge = nil }
            }
        )
    }

    // MARK: - States

    private var loadingState: some View {
        VStack(spacing: 14) {
            ProgressView().tint(TwoWatchTheme.brandPrimary)
            Text("Carico l'invito…")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(TwoWatchTheme.textSecondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder
    private func content(_ vm: QuizInviteOnboardingViewModel) -> some View {
        switch vm.phase {
        case .loading:
            loadingState
        case .picking, .finalizing:
            pickingState(vm)
        case let .needMoreTitles(available):
            needMoreState(vm, available: available)
        case let .error(message):
            errorState(vm, message: message)
        }
    }

    // MARK: - Picking

    private func pickingState(_ vm: QuizInviteOnboardingViewModel) -> some View {
        @Bindable var vm = vm
        let isFinalizing = vm.phase == .finalizing
        return ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                introCard(vm)

                titleGridSection(vm)

                addMoreSection(vm)

                Color.clear.frame(height: 8)
            }
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, 24)
        }
        .scrollDismissesKeyboard(.interactively)
        .scrollIndicators(.hidden)
        .safeAreaInset(edge: .bottom) {
            startBar(vm, isFinalizing: isFinalizing)
        }
    }

    private func introCard(_ vm: QuizInviteOnboardingViewModel) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                Image(systemName: "popcorn.fill")
                    .font(.title2.weight(.bold))
                    .foregroundStyle(.white)
                    .frame(width: 46, height: 46)
                    .background(TwoWatchTheme.brandGradient, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(vm.claim.inviterDisplayName) ti ha sfidato")
                        .font(.headline.weight(.heavy))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)
                    Text("\(vm.claim.numQuestions) domande su film e serie")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                        .monospacedDigit()
                }
                Spacer(minLength: 0)
            }
            Text("Seleziona almeno 2 titoli che hai visto, così troviamo domande giuste per entrambi.")
                .font(.subheadline)
                .foregroundStyle(TwoWatchTheme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .quizGlowCard(cornerRadius: 22, glowStrength: 0.45)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private func titleGridSection(_ vm: QuizInviteOnboardingViewModel) -> some View {
        let titles = vm.allOfferedTitles
        if !titles.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) {
                    Text("Titoli che hai visto")
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                    Spacer()
                    QuizStatusPill(
                        label: "\(vm.selectedCount) scelti",
                        tint: vm.meetsMinimum ? TwoWatchTheme.success : TwoWatchTheme.warning,
                        systemImage: "checkmark"
                    )
                }
                LazyVGrid(
                    columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)],
                    spacing: 10
                ) {
                    ForEach(titles, id: \.id) { title in
                        QuizTitleSelectChip(
                            title: title,
                            isSelected: vm.selectedIds.contains(title.id),
                            onTap: { vm.toggle(title) }
                        )
                    }
                }
            }
        } else {
            VStack(alignment: .leading, spacing: 8) {
                Text("Titoli che hai visto")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                HStack(spacing: 10) {
                    Image(systemName: "magnifyingglass")
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.accent)
                    Text("Cerca qui sotto i film e le serie che hai visto.")
                        .font(.caption)
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .fill(TwoWatchTheme.panel)
                )
            }
        }
    }

    private func addMoreSection(_ vm: QuizInviteOnboardingViewModel) -> some View {
        @Bindable var vm = vm
        return VStack(alignment: .leading, spacing: 10) {
            Text("Aggiungi altri titoli")
                .font(.subheadline.weight(.bold))
                .foregroundStyle(TwoWatchTheme.textPrimary)

            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(TwoWatchTheme.textMuted)
                TextField("Cerca un film o una serie", text: $vm.searchQuery)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                    .autocorrectionDisabled()
                    .submitLabel(.search)
                    .onChange(of: vm.searchQuery) { _, newValue in
                        vm.updateSearch(newValue)
                    }
                if vm.isSearching {
                    ProgressView()
                        .controlSize(.small)
                        .tint(TwoWatchTheme.brandPrimary)
                } else if !vm.searchQuery.isEmpty {
                    Button {
                        vm.updateSearch("")
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(TwoWatchTheme.textMuted)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Cancella ricerca")
                }
            }
            .padding(.horizontal, 14)
            .frame(height: 48)
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(TwoWatchTheme.panel)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .stroke(TwoWatchTheme.border, lineWidth: 1)
            )

            if !vm.searchResults.isEmpty {
                VStack(spacing: 8) {
                    ForEach(vm.searchResults, id: \.id) { title in
                        QuizTitleSearchRow(
                            title: title,
                            isAdded: vm.selectedIds.contains(title.id),
                            onAdd: { vm.addFromSearch(title) }
                        )
                    }
                }
            } else if vm.searchQuery.trimmingCharacters(in: .whitespaces).count >= 2 && !vm.isSearching {
                Text("Nessun titolo trovato per “\(vm.searchQuery)”.")
                    .font(.caption)
                    .foregroundStyle(TwoWatchTheme.textMuted)
                    .padding(.vertical, 4)
            }
        }
    }

    private func startBar(_ vm: QuizInviteOnboardingViewModel, isFinalizing: Bool) -> some View {
        VStack(spacing: 8) {
            if !vm.meetsMinimum {
                HStack(spacing: 6) {
                    Image(systemName: "lightbulb.fill")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.warning)
                    Text("Più titoli scegli, migliore sarà la sfida.")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            Button {
                UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                Task { await vm.finalize() }
            } label: {
                HStack(spacing: 10) {
                    if isFinalizing {
                        ProgressView().tint(.white).controlSize(.small)
                        Text("Preparo la sfida…")
                    } else {
                        Image(systemName: "play.fill")
                        Text("Inizia sfida")
                    }
                }
            }
            .buttonStyle(PrimaryButtonStyle())
            .disabled(!vm.meetsMinimum || isFinalizing)
            .opacity(vm.meetsMinimum ? 1 : 0.5)
            .accessibilityLabel(vm.meetsMinimum
                ? "Inizia la sfida"
                : "Inizia la sfida. Seleziona almeno due titoli per continuare.")
        }
        .padding(.horizontal, 16)
        .padding(.top, 12)
        .padding(.bottom, 8)
        .background(.ultraThinMaterial)
        .overlay(alignment: .top) {
            Rectangle()
                .fill(TwoWatchTheme.border)
                .frame(height: 1)
        }
    }

    // MARK: - Need more titles

    private func needMoreState(_ vm: QuizInviteOnboardingViewModel, available: Int) -> some View {
        ScrollView {
            VStack(spacing: 18) {
                VStack(spacing: 12) {
                    Image(systemName: "tray.and.arrow.down.fill")
                        .font(.system(size: 38, weight: .bold))
                        .foregroundStyle(TwoWatchTheme.warning)
                    Text("Servono più titoli")
                        .font(.title3.weight(.heavy))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                    Text(available > 0
                        ? "Con questi titoli abbiamo solo \(available) domande. Aggiungine altri per una sfida completa."
                        : "Non abbiamo abbastanza domande su questi titoli. Aggiungine altri che hai visto.")
                        .font(.subheadline)
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(20)
                .frame(maxWidth: .infinity)
                .quizGlowCard(cornerRadius: 22, glowColor: TwoWatchTheme.warning, glowStrength: 0.4)

                addMoreSection(vm)

                Button {
                    vm.phase = .picking
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "arrow.uturn.backward")
                        Text("Torna alla selezione")
                    }
                }
                .buttonStyle(PrimaryButtonStyle())
                .accessibilityLabel("Torna alla selezione dei titoli")
            }
            .padding(.horizontal, 16)
            .padding(.top, 16)
            .padding(.bottom, 24)
        }
        .scrollIndicators(.hidden)
    }

    // MARK: - Error

    private func errorState(_ vm: QuizInviteOnboardingViewModel, message: String) -> some View {
        VStack(spacing: 16) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 38, weight: .bold))
                .foregroundStyle(TwoWatchTheme.brandPrimary)
            Text("Qualcosa è andato storto")
                .font(.title3.weight(.heavy))
                .foregroundStyle(TwoWatchTheme.textPrimary)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(TwoWatchTheme.textSecondary)
                .multilineTextAlignment(.center)
            Button {
                vm.phase = .picking
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "arrow.clockwise")
                    Text("Riprova")
                }
            }
            .buttonStyle(PrimaryButtonStyle())
            .accessibilityLabel("Riprova")
        }
        .padding(28)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - Title select chip (grid)

private struct QuizTitleSelectChip: View {
    let title: Title
    let isSelected: Bool
    let onTap: () -> Void

    var body: some View {
        Button(action: {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            onTap()
        }) {
            HStack(spacing: 10) {
                PosterImageView(url: title.posterPath, width: 42, height: 60, cornerRadius: 9)
                VStack(alignment: .leading, spacing: 3) {
                    Text(title.name)
                        .font(.caption.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                    Text(title.subtitle)
                        .font(.caption2)
                        .foregroundStyle(TwoWatchTheme.textMuted)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(isSelected ? TwoWatchTheme.success : TwoWatchTheme.textMuted)
            }
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(isSelected ? TwoWatchTheme.success.opacity(0.12) : TwoWatchTheme.panel)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .stroke(isSelected ? TwoWatchTheme.success.opacity(0.5) : TwoWatchTheme.border, lineWidth: 1)
            )
        }
        .buttonStyle(QuizPressableStyle())
        .accessibilityLabel("\(title.name). \(isSelected ? "Selezionato" : "Non selezionato")")
        .accessibilityAddTraits(isSelected ? [.isSelected, .isButton] : .isButton)
    }
}

// MARK: - Title search row

private struct QuizTitleSearchRow: View {
    let title: Title
    let isAdded: Bool
    let onAdd: () -> Void

    var body: some View {
        Button(action: {
            if !isAdded {
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                onAdd()
            }
        }) {
            HStack(spacing: 12) {
                PosterImageView(url: title.posterPath, width: 38, height: 54, cornerRadius: 8)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title.name)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                        .lineLimit(1)
                    Text(title.subtitle)
                        .font(.caption)
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                Image(systemName: isAdded ? "checkmark.circle.fill" : "plus.circle.fill")
                    .font(.title3)
                    .foregroundStyle(isAdded ? TwoWatchTheme.success : TwoWatchTheme.brandPrimary)
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(TwoWatchTheme.panel)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .stroke(TwoWatchTheme.border, lineWidth: 1)
            )
        }
        .buttonStyle(QuizPressableStyle())
        .disabled(isAdded)
        .accessibilityLabel(isAdded ? "\(title.name), già aggiunto" : "Aggiungi \(title.name)")
    }
}
