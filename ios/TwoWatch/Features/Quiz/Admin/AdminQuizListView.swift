import SwiftUI

@Observable
@MainActor
final class AdminQuizListViewModel {
    let container: AppContainer
    let session: SessionStore

    var filter: QuizRepository.AdminFilter = .pendingReview
    var questions: [QuizQuestion] = []
    var stats: QuizRepository.AdminStats?
    var isLoading = false
    var errorMessage: String?

    init(container: AppContainer, session: SessionStore) {
        self.container = container
        self.session = session
    }

    func load() async {
        guard session.appUser?.permissions.canRunAdminTools == true else {
            errorMessage = "Permessi insufficienti."
            return
        }
        isLoading = true
        defer { isLoading = false }
        do {
            async let qs = container.quizRepository.fetchAdminQuestions(filter: filter)
            async let st = container.quizRepository.fetchAdminStats()
            questions = try await qs
            stats = try await st
            errorMessage = nil
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }
}

struct AdminQuizListView: View {
    let container: AppContainer
    let session: SessionStore

    @State private var viewModel: AdminQuizListViewModel?

    var body: some View {
        Group {
            if session.appUser?.permissions.canRunAdminTools != true {
                deniedView
            } else if let vm = viewModel {
                content(vm)
            } else {
                ProgressView().tint(TwoWatchTheme.brandPrimary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(TwoWatchTheme.background.ignoresSafeArea())
        .navigationTitle("Admin Quiz")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if viewModel == nil {
                let vm = AdminQuizListViewModel(container: container, session: session)
                viewModel = vm
                await vm.load()
            }
        }
    }

    private var deniedView: some View {
        VStack(spacing: 8) {
            Image(systemName: "lock.fill")
                .font(.largeTitle)
                .foregroundStyle(TwoWatchTheme.warning)
            Text("Sezione riservata agli admin.")
                .font(.subheadline)
                .foregroundStyle(TwoWatchTheme.textSecondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder
    private func content(_ vm: AdminQuizListViewModel) -> some View {
        @Bindable var vm = vm
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let stats = vm.stats {
                    statsRow(stats)
                }
                filterRow(vm: vm)

                if vm.isLoading && vm.questions.isEmpty {
                    ProgressView().tint(TwoWatchTheme.brandPrimary).padding()
                } else if vm.questions.isEmpty {
                    Text("Nessuna domanda in questo filtro.")
                        .font(.footnote)
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                        .padding(.vertical, 24)
                } else {
                    LazyVStack(spacing: 10) {
                        ForEach(vm.questions, id: \.id) { q in
                            NavigationLink {
                                AdminQuizEditorView(container: container, session: session, question: q) {
                                    Task { await vm.load() }
                                }
                            } label: {
                                AdminQuizRow(question: q)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
            .padding(16)
        }
        .refreshable { await vm.load() }
    }

    private func statsRow(_ stats: QuizRepository.AdminStats) -> some View {
        HStack(spacing: 10) {
            AdminStatChip(label: "domande", value: "\(stats.total)", color: TwoWatchTheme.brandPrimary)
            AdminStatChip(label: "medium", value: "\(stats.mediumConfidence)", color: TwoWatchTheme.accent)
            AdminStatChip(label: "heavy", value: "\(stats.heavySpoiler)", color: TwoWatchTheme.warning)
        }
    }

    private func filterRow(vm: AdminQuizListViewModel) -> some View {
        @Bindable var vm = vm
        return ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(QuizRepository.AdminFilter.allCases, id: \.self) { f in
                    let isActive = vm.filter == f
                    Button {
                        vm.filter = f
                        Task { await vm.load() }
                    } label: {
                        Text(f.rawValue)
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(isActive ? .white : TwoWatchTheme.textPrimary)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 7)
                            .background(
                                Capsule().fill(isActive ? TwoWatchTheme.brandPrimary : TwoWatchTheme.panel)
                            )
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(f.rawValue)
                    .accessibilityAddTraits(isActive ? [.isButton, .isSelected] : .isButton)
                }
            }
        }
    }
}

private struct AdminStatChip: View {
    let label: String
    let value: String
    let color: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(value)
                .font(.title3.weight(.bold))
                .foregroundStyle(color)
            Text(label)
                .font(.caption2)
                .foregroundStyle(TwoWatchTheme.textSecondary)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 12).fill(TwoWatchTheme.panel)
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(TwoWatchTheme.border, lineWidth: 1))
        )
    }
}

private struct AdminQuizRow: View {
    let question: QuizQuestion

    var body: some View {
        HStack(spacing: 12) {
            Circle().fill(statusColor).frame(width: 10, height: 10)
            VStack(alignment: .leading, spacing: 4) {
                Text(question.questionText)
                    .font(.subheadline)
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                    .lineLimit(2)
                HStack(spacing: 6) {
                    Text(question.title).font(.caption).foregroundStyle(TwoWatchTheme.textSecondary)
                    Text("·").foregroundStyle(TwoWatchTheme.textMuted)
                    Text(question.status.rawValue).font(.caption2).foregroundStyle(TwoWatchTheme.textSecondary)
                    if question.spoilerLevel == .heavy {
                        Text("heavy")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(TwoWatchTheme.warning)
                            .padding(.horizontal, 6).padding(.vertical, 1)
                            .background(TwoWatchTheme.warning.opacity(0.18), in: Capsule())
                    }
                    if question.confidence == .medium {
                        Text("medium")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(TwoWatchTheme.accent)
                            .padding(.horizontal, 6).padding(.vertical, 1)
                            .background(TwoWatchTheme.accent.opacity(0.18), in: Capsule())
                    }
                }
            }
            Spacer()
            Image(systemName: "chevron.right").foregroundStyle(TwoWatchTheme.textMuted)
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 12).fill(TwoWatchTheme.panel)
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(TwoWatchTheme.border, lineWidth: 1))
        )
    }

    private var statusColor: Color {
        switch question.status {
        case .approved: return TwoWatchTheme.success
        case .flagged: return TwoWatchTheme.warning
        case .discarded: return TwoWatchTheme.textMuted
        case .betaPendingReview: return TwoWatchTheme.brandPrimary
        }
    }
}
