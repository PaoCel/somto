import Observation
import SwiftUI

@Observable
@MainActor
final class ProfileInboxViewModel {
    private let repository: SocialInboxRepository

    var section: ProfileInboxSection = .received
    var receivedRecommendations: [RecommendationItem] = []
    var sentRecommendations: [RecommendationItem] = []
    var isLoading = false
    var archivingIDs: Set<String> = []
    var errorMessage: String?

    init(repository: SocialInboxRepository) {
        self.repository = repository
    }

    func load(userID: String) async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        do {
            async let receivedTask = repository.fetchReceivedRecommendations(userID: userID)
            async let sentTask = repository.fetchSentRecommendations(userID: userID)

            receivedRecommendations = try await receivedTask
            sentRecommendations = try await sentTask
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }

    func markViewed(recommendationID: String, userID: String) async {
        do {
            try await repository.markRecommendationViewed(recommendationID)
            await load(userID: userID)
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }

    func archive(recommendationID: String, userID: String) async {
        guard !archivingIDs.contains(recommendationID) else { return }
        archivingIDs.insert(recommendationID)
        defer { archivingIDs.remove(recommendationID) }
        do {
            try await repository.archiveRecommendation(recommendationID)
            receivedRecommendations.removeAll { $0.id == recommendationID }
            sentRecommendations.removeAll { $0.id == recommendationID }
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }
}

struct ProfileInboxView: View {
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore

    @State private var viewModel: ProfileInboxViewModel

    init(container: AppContainer, session: SessionStore, shell: AppShellStore) {
        self.container = container
        self.session = session
        self.shell = shell
        _viewModel = State(initialValue: ProfileInboxViewModel(
            repository: container.socialInboxRepository
        ))
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                if !session.isAuthenticated {
                    EmptyStateView(
                        title: "Inbox privata",
                        message: "Richieste amicizia e recommendation sono legate al tuo account.",
                        systemImage: "tray.full.fill",
                        actionTitle: "Accedi"
                    ) {
                        shell.presentAuth()
                    }
                } else {
                    header
                    content
                }
            }
            .padding(20)
        }
        .background(TwoWatchBackground())
        .navigationTitle("Inbox sociale")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                AppMenuButton(shell: shell)
            }

            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    shell.presentSearch()
                } label: {
                    Image(systemName: "magnifyingglass")
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                }
            }
        }
        .task(id: session.firebaseUser?.uid) {
            if let userID = session.firebaseUser?.uid {
                await viewModel.load(userID: userID)
            }
        }
        .refreshable {
            if let userID = session.firebaseUser?.uid {
                await viewModel.load(userID: userID)
            }
        }
        .alert("Errore", isPresented: Binding(
            get: { viewModel.errorMessage != nil },
            set: { _ in viewModel.errorMessage = nil }
        )) {
            Button("Chiudi", role: .cancel) {}
        } message: {
            Text(viewModel.errorMessage ?? "")
        }
    }

    private var header: some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 14) {
                Text("Gestisci i suggerimenti ricevuti e quelli che hai inviato.")
                    .font(.subheadline)
                    .foregroundStyle(TwoWatchTheme.textSecondary)

                HStack(spacing: 12) {
                    inboxMetric("\(viewModel.receivedRecommendations.count)", label: "ricevuti")
                    inboxMetric("\(viewModel.sentRecommendations.count)", label: "inviati")
                }

                Picker("Inbox", selection: Binding(
                    get: { viewModel.section },
                    set: { viewModel.section = $0 }
                )) {
                    ForEach(ProfileInboxSection.allCases) { section in
                        Text(LocalizedStringKey(section.rawValue)).tag(section)
                    }
                }
                .pickerStyle(.segmented)
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        if viewModel.isLoading && viewModel.receivedRecommendations.isEmpty && viewModel.sentRecommendations.isEmpty {
            VStack(spacing: 12) {
                ProgressView()
                    .tint(TwoWatchTheme.textPrimary)
                Text("Carico i suggerimenti…")
                    .font(.subheadline)
                    .foregroundStyle(TwoWatchTheme.textSecondary)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 36)
        } else { switch viewModel.section {
        case .received:
            if viewModel.receivedRecommendations.isEmpty {
                EmptyStateView(
                    title: "Nessun suggerimento",
                    message: "I consigli ricevuti compariranno qui appena arrivano.",
                    systemImage: "sparkles.tv"
                )
            } else {
                ForEach(viewModel.receivedRecommendations) { item in
                    recommendationRow(item, received: true)
                }
            }
        case .sent:
            if viewModel.sentRecommendations.isEmpty {
                EmptyStateView(
                    title: "Ancora nessun consiglio inviato",
                    message: "Quando suggerisci un titolo a un amico, lo ritrovi qui.",
                    systemImage: "paperplane"
                )
            } else {
                ForEach(viewModel.sentRecommendations) { item in
                    recommendationRow(item, received: false)
                }
            }
        }
        }
    }

    @ViewBuilder
    private func recommendationRow(_ item: RecommendationItem, received: Bool) -> some View {
        let destination = recommendationDestination(item, received: received)
        destination
    }

    @ViewBuilder
    private func recommendationDestination(_ item: RecommendationItem, received: Bool) -> some View {
        if let threadID = item.threadId, !threadID.isEmpty {
            NavigationLink {
                ThreadDetailView(container: container, session: session, shell: shell, threadID: threadID)
            } label: {
                recommendationCard(item, received: received)
            }
            .buttonStyle(.plain)
            .simultaneousGesture(TapGesture().onEnded {
                if received, let userID = session.firebaseUser?.uid {
                    Task { await viewModel.markViewed(recommendationID: item.id, userID: userID) }
                }
            })
        } else if let title = item.title {
            NavigationLink {
                TitleDetailView(container: container, session: session, shell: shell, titleID: title.id)
            } label: {
                recommendationCard(item, received: received)
            }
            .buttonStyle(.plain)
        } else {
            recommendationCard(item, received: received)
        }
    }

    private func recommendationCard(_ item: RecommendationItem, received: Bool) -> some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 12) {
                    if let posterURL = item.title?.posterPath {
                        PosterImageView(url: posterURL, width: 64, height: 94, cornerRadius: 16)
                    } else {
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .fill(TwoWatchTheme.panelStrong)
                            .frame(width: 64, height: 94)
                            .overlay(
                                Image(systemName: "film")
                                    .foregroundStyle(TwoWatchTheme.textSecondary)
                            )
                    }

                    VStack(alignment: .leading, spacing: 6) {
                        Text(item.title?.name ?? "Titolo non disponibile")
                            .font(.headline.weight(.bold))
                            .foregroundStyle(TwoWatchTheme.textPrimary)
                        Text(received ? "Da \(item.counterpart?.displayName ?? item.fromUid)" : "A \(item.counterpart?.displayName ?? item.toUid)")
                            .font(.subheadline)
                            .foregroundStyle(TwoWatchTheme.textSecondary)
                        if !item.message.isEmpty {
                            SpoilerGate(
                                containsSpoiler: item.containsSpoiler,
                                spoilerTitleIDs: item.spoilerTitleIds,
                                viewerCompletedTitleIDs: session.completedTitleIDs,
                                titleNames: item.title.map { [$0.id: $0.name] } ?? [:],
                                onMarkSeen: { titleID in
                                    guard let uid = session.firebaseUser?.uid else { return }
                                    do {
                                        _ = try await container.watchlistRepository.markTitleCompletedByID(userID: uid, titleID: titleID)
                                        session.markTitleCompletedLocally(titleID)
                                    } catch { /* silent */ }
                                }
                            ) {
                                Text("“\(item.message)”")
                                    .font(.caption)
                                    .foregroundStyle(TwoWatchTheme.textSecondary)
                                    .lineLimit(3)
                            }
                        }
                    }

                    Spacer()
                }

                HStack {
                    if received {
                        Text(item.isUnread ? "Nuovo" : "Visto")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(item.isUnread ? TwoWatchTheme.brandPrimary : TwoWatchTheme.textSecondary)
                    } else {
                        Text(item.viewedAt == nil ? "In attesa" : "Visto")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(item.viewedAt == nil ? TwoWatchTheme.brandPrimary : TwoWatchTheme.textSecondary)
                    }
                    Spacer()
                    if let userID = session.firebaseUser?.uid {
                        Button {
                            Task { await viewModel.archive(recommendationID: item.id, userID: userID) }
                        } label: {
                            if viewModel.archivingIDs.contains(item.id) {
                                HStack(spacing: 6) {
                                    ProgressView()
                                    Text("Archiviazione…")
                                }
                            } else {
                                Text("Archivia")
                            }
                        }
                        .buttonStyle(.plain)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                        .disabled(viewModel.archivingIDs.contains(item.id))
                    }
                }
            }
        }
    }

    private func inboxMetric(_ value: String, label: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(value)
                .font(.headline.weight(.bold))
                .foregroundStyle(TwoWatchTheme.textPrimary)
            Text(label)
                .font(.caption)
                .foregroundStyle(TwoWatchTheme.textSecondary)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(TwoWatchTheme.panelStrong, in: Capsule())
    }
}
