import SwiftUI

// MARK: - Setup mode

/// How a solo run picks its questions: a surprise draw from the whole archive,
/// or a single title the player searches for.
enum QuizSetupMode: String, CaseIterable, Hashable {
    case random
    case specific

    var label: String {
        switch self {
        case .random: return "Casuale"
        case .specific: return "Titolo specifico"
        }
    }
}

// MARK: - Setup view model

@Observable
@MainActor
final class QuizGameSetupViewModel {
    let container: AppContainer
    let session: SessionStore

    var mode: QuizSetupMode = .random
    var questionCount: Int = 5
    /// Set only in `.specific` mode once the player picks a title.
    var selectedTitleId: String?
    /// Alternativa al titolo singolo: una saga intera (`quizMeta/sagas`). I
    /// due sono esclusivi, ci pensa il picker a spegnere l'altro.
    var selectedSagaId: String?

    /// Backs the "titolo specifico" vetrina. Built once; loads lazily the first
    /// time the player switches to that mode.
    let catalog: QuizTitleCatalogStore

    let questionCountOptions = [3, 5, 10]

    init(container: AppContainer, session: SessionStore) {
        self.container = container
        self.session = session
        self.catalog = QuizTitleCatalogStore(
            container: container,
            seenTitleIds: session.completedTitleIDs
        )
    }

    var selectedTheme: QuizTheme? {
        guard let selectedTitleId else { return nil }
        return catalog.themes.first { $0.titleId == selectedTitleId }
    }

    var selectedSaga: QuizSaga? {
        guard let selectedSagaId else { return nil }
        return catalog.sagas.first { $0.sagaId == selectedSagaId }
    }

    /// The titleId handed to the player — `nil` means a random run **or** a
    /// saga run, che passa invece da `playSagaTitleIds`.
    var playTitleId: String? {
        guard mode == .specific, selectedSaga == nil else { return nil }
        return selectedTitleId
    }

    /// Titoli da cui pescare quando la scelta e' una saga. Vuoto altrimenti.
    var playSagaTitleIds: [String] {
        guard mode == .specific, let selectedSaga else { return [] }
        return selectedSaga.titleIds
    }

    var canStart: Bool {
        mode == .random || selectedTitleId != nil || selectedSaga != nil
    }
}

// MARK: - Setup view

/// Pre-game fork: choose between a random run and a specific title, pick how
/// many questions, then start. Replaces the old flat theme list.
struct QuizGameSetupView: View {
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore
    /// Chiamata quando il giocatore chiude il risultato: la passa al player
    /// come `onClose` cosi' la chiusura smonta setup **e** player insieme e si
    /// riatterra sull'hub (chi la fornisce e' `QuizHomeView`).
    var onFinishedGame: (() -> Void)? = nil

    @State private var viewModel: QuizGameSetupViewModel?

    var body: some View {
        Group {
            if let viewModel {
                content(viewModel)
            } else {
                ProgressView().tint(TwoWatchTheme.brandPrimary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(TwoWatchTheme.background.ignoresSafeArea())
        .navigationTitle("Nuova partita")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(TwoWatchTheme.background.opacity(0.95), for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .task {
            if viewModel == nil {
                viewModel = QuizGameSetupViewModel(container: container, session: session)
            }
        }
    }

    @ViewBuilder
    private func content(_ vm: QuizGameSetupViewModel) -> some View {
        @Bindable var vm = vm
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                modeSection(vm: vm)

                switch vm.mode {
                case .random:
                    randomInfoCard
                case .specific:
                    QuizTitlePickerView(
                        store: vm.catalog,
                        selectedTitleId: $vm.selectedTitleId,
                        selectedSagaId: $vm.selectedSagaId
                    )
                }

                questionCountSection(vm: vm)
            }
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, 24)
        }
        .scrollIndicators(.hidden)
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom) {
            startBar(vm: vm)
        }
        .task(id: vm.mode) {
            if vm.mode == .specific {
                await vm.catalog.loadIfNeeded()
            }
        }
    }

    // MARK: - Mode section

    private func modeSection(vm: QuizGameSetupViewModel) -> some View {
        @Bindable var vm = vm
        return VStack(alignment: .leading, spacing: 10) {
            sectionHeader(
                icon: "dice.fill",
                title: String(localized: "Come vuoi giocare?"),
                subtitle: String(localized: "Domande a sorpresa, oppure su un titolo che scegli tu.")
            )
            QuizSegmentedControl(
                options: QuizSetupMode.allCases,
                selection: $vm.mode,
                label: { $0.label }
            )
        }
    }

    private var randomInfoCard: some View {
        HStack(spacing: 12) {
            Image(systemName: "shuffle")
                .font(.headline.weight(.bold))
                .foregroundStyle(TwoWatchTheme.brandPrimary)
                .frame(width: 40, height: 40)
                .background(TwoWatchTheme.brandPrimary.opacity(0.18), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text("Tema a sorpresa")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                Text("Le domande arrivano a caso dall'intero archivio di film e serie.")
                    .font(.caption)
                    .foregroundStyle(TwoWatchTheme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .quizGlowCard(cornerRadius: 18, glowColor: TwoWatchTheme.brandPrimary, glowStrength: 0)
    }

    // MARK: - Question count section

    private func questionCountSection(vm: QuizGameSetupViewModel) -> some View {
        @Bindable var vm = vm
        return VStack(alignment: .leading, spacing: 10) {
            sectionHeader(icon: "list.number", title: "Quante domande?", subtitle: nil)
            QuizSegmentedControl(
                options: vm.questionCountOptions,
                selection: $vm.questionCount,
                label: { "\($0)" }
            )
        }
    }

    // MARK: - Start bar

    @ViewBuilder
    private func startBar(vm: QuizGameSetupViewModel) -> some View {
        Group {
            if vm.canStart {
                NavigationLink {
                    QuizPlayView(
                        container: container,
                        session: session,
                        shell: shell,
                        mode: .solo,
                        challenge: nil,
                        selectedTitleId: vm.playTitleId,
                        sagaTitleIds: vm.playSagaTitleIds,
                        questionCount: vm.questionCount,
                        onClose: onFinishedGame
                    )
                } label: {
                    startLabel(vm: vm)
                }
                .buttonStyle(PrimaryButtonStyle())
                .simultaneousGesture(TapGesture().onEnded {
                    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                })
            } else {
                Button(action: {}) {
                    startLabel(vm: vm)
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(true)
                .opacity(0.5)
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 10)
        .padding(.bottom, 12)
        .background(.ultraThinMaterial)
        .accessibilityLabel(startAccessibility(vm: vm))
    }

    @ViewBuilder
    private func startLabel(vm: QuizGameSetupViewModel) -> some View {
        HStack(spacing: 10) {
            if vm.mode == .specific && !vm.canStart {
                Image(systemName: "film.stack")
                Text("Scegli un titolo")
            } else if let saga = vm.selectedSaga, vm.mode == .specific {
                Image(systemName: "play.fill")
                Text("Gioca su \(saga.name)")
                    .lineLimit(1)
            } else if let theme = vm.selectedTheme, vm.mode == .specific {
                Image(systemName: "play.fill")
                Text("Gioca su \(theme.title)")
                    .lineLimit(1)
            } else {
                Image(systemName: "play.fill")
                Text("Inizia partita")
            }
        }
    }

    private func startAccessibility(vm: QuizGameSetupViewModel) -> String {
        if vm.mode == .specific && !vm.canStart {
            return String(localized: "Scegli prima un titolo per iniziare.")
        }
        let theme = vm.selectedSaga?.name
            ?? vm.selectedTheme?.title
            ?? String(localized: "Tutti i titoli")
        return String(localized: "Inizia partita con \(vm.questionCount) domande, tema \(theme).")
    }

    // MARK: - Shared bits

    private func sectionHeader(icon: String, title: String, subtitle: String?) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 8) {
                Image(systemName: icon)
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.brandPrimary)
                Text(title)
                    .font(.headline.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
            }
            if let subtitle {
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(TwoWatchTheme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
    }
}
