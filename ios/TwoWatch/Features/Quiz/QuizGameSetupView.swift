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

    /// The titleId handed to the player — `nil` means a random run.
    var playTitleId: String? {
        mode == .random ? nil : selectedTitleId
    }

    var canStart: Bool {
        mode == .random || selectedTitleId != nil
    }
}

// MARK: - Setup view

/// Pre-game fork: choose between a random run and a specific title, pick how
/// many questions, then start. Replaces the old flat theme list.
struct QuizGameSetupView: View {
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore

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
                        selectedTitleId: $vm.selectedTitleId
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
                        questionCount: vm.questionCount
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
            if vm.mode == .specific && vm.selectedTitleId == nil {
                Image(systemName: "film.stack")
                Text("Scegli un titolo")
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
        if vm.mode == .specific && vm.selectedTitleId == nil {
            return String(localized: "Scegli prima un titolo per iniziare.")
        }
        let theme = vm.selectedTheme?.title ?? "Tutti i titoli"
        return "Inizia partita con \(vm.questionCount) domande, tema \(theme)."
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
