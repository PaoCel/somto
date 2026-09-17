import Observation
import SwiftUI

@Observable
@MainActor
final class TitleDiscussionsStore {
    private let threadsRepository: ThreadsRepository

    var threads: [AppThread] = []
    var isLoading = false
    @ObservationIgnored private var loadedTitleID: String?

    init(threadsRepository: ThreadsRepository) {
        self.threadsRepository = threadsRepository
    }

    /// Discussioni aperte sul titolo, ordinate: prima quella generale, poi le
    /// stagioni, poi gli episodi — e a parità di livello le più vive prima.
    func load(titleID: String) async {
        guard loadedTitleID != titleID else { return }
        loadedTitleID = titleID
        isLoading = true
        defer { isLoading = false }

        let fetched = (try? await threadsRepository.listPublicThreadsForTitle(titleID)) ?? []
        threads = fetched
            .filter { !$0.lastMessagePreview.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            .sorted { lhs, rhs in
                let lKey = lhs.scope.hierarchyKey
                let rKey = rhs.scope.hierarchyKey
                if lKey.0 != rKey.0 { return lKey.0 < rKey.0 }
                let lDate = lhs.lastMessageAt ?? .distantPast
                let rDate = rhs.lastMessageAt ?? .distantPast
                return lDate > rDate
            }
    }
}

/// "Discussioni su questo titolo" nella scheda del film/serie.
///
/// Prima l'unico aggancio era un link di testo in fondo al tab Social —
/// *"Vedi tutte le review nel thread pubblico"* — che parlava di review, non di
/// discussioni, e non lasciava intuire l'esistenza dei thread di stagione e di
/// episodio. Qui si vedono quelle davvero aperte, con il livello dichiarato, e
/// da una sola porta si arriva a tutte.
struct TitleDiscussionsCard: View {
    let title: Title
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore
    let isAuthenticated: Bool
    let onRequestAuth: () -> Void

    @State private var store: TitleDiscussionsStore
    @State private var isExplorerPresented = false

    /// Quante discussioni mostrare inline prima del "vedi tutte".
    private let inlineCap = 3

    init(
        title: Title,
        container: AppContainer,
        session: SessionStore,
        shell: AppShellStore,
        isAuthenticated: Bool,
        onRequestAuth: @escaping () -> Void
    ) {
        self.title = title
        self.container = container
        self.session = session
        self.shell = shell
        self.isAuthenticated = isAuthenticated
        self.onRequestAuth = onRequestAuth
        _store = State(initialValue: TitleDiscussionsStore(threadsRepository: container.threadsRepository))
    }

    var body: some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 12) {
                header

                if !isAuthenticated {
                    Button("Accedi per leggere e partecipare", action: onRequestAuth)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(TwoWatchTheme.brandPrimary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else if store.isLoading && store.threads.isEmpty {
                    ProgressView()
                        .tint(TwoWatchTheme.accent)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                } else if store.threads.isEmpty {
                    emptyState
                } else {
                    VStack(spacing: 8) {
                        ForEach(store.threads.prefix(inlineCap), id: \.id) { thread in
                            discussionRow(thread)
                        }
                    }
                }

                if isAuthenticated {
                    Button {
                        isExplorerPresented = true
                    } label: {
                        HStack(spacing: 6) {
                            Text(store.threads.isEmpty ? "Apri una discussione" : "Vedi tutte le discussioni")
                                .font(.subheadline.weight(.bold))
                            Image(systemName: "arrow.right")
                                .font(.caption.weight(.heavy))
                        }
                        .foregroundStyle(TwoWatchTheme.brandPrimary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .task(id: title.id) {
            guard isAuthenticated else { return }
            await store.load(titleID: title.id)
        }
        .sheet(isPresented: $isExplorerPresented) {
            ThreadExplorerView(
                container: container,
                session: session,
                shell: shell,
                initialTitle: title
            )
        }
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Discussioni su questo titolo")
                    .font(.headline.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                Text(subtitleText)
                    .font(.caption)
                    .foregroundStyle(TwoWatchTheme.textMuted)
            }
            Spacer(minLength: 0)
            if !store.threads.isEmpty {
                Text("\(store.threads.count)")
                    .font(.system(size: 13, weight: .heavy, design: .rounded))
                    .foregroundStyle(TwoWatchTheme.accent)
                    .monospacedDigit()
                    .padding(.horizontal, 9)
                    .padding(.vertical, 4)
                    .background(TwoWatchTheme.accent.opacity(0.14), in: Capsule())
                    .accessibilityLabel("\(store.threads.count) discussioni aperte")
            }
        }
    }

    private var subtitleText: String {
        title.type == .tv
            ? "Serie intera, stagioni e singoli episodi"
            : "Cosa ne pensa chi l'ha visto"
    }

    private var emptyState: some View {
        Text(title.type == .tv
             ? "Ancora nessuna discussione aperta. Puoi partire dalla serie, da una stagione o da un episodio."
             : "Ancora nessuna discussione aperta su questo film.")
            .font(.subheadline)
            .foregroundStyle(TwoWatchTheme.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func discussionRow(_ thread: AppThread) -> some View {
        NavigationLink {
            ThreadDetailView(
                container: container,
                session: session,
                shell: shell,
                threadID: thread.id,
                publicThreadSeed: seed(for: thread)
            )
        } label: {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: thread.scope.symbolName)
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(thread.scope.tint)
                    .frame(width: 30, height: 30)
                    .background(thread.scope.tint.opacity(0.14), in: Circle())

                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        ThreadScopeBadge(scope: thread.scope, compact: true)
                        if let score = thread.previewSplit.score {
                            ThreadRatingBadge(score: score)
                        }
                        Spacer(minLength: 0)
                    }

                    if !thread.previewSplit.text.isEmpty {
                        Text(thread.previewSplit.text)
                            .font(.system(size: 13))
                            .foregroundStyle(TwoWatchTheme.textSecondary)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                Spacer(minLength: 0)

                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.textMuted)
                    .padding(.top, 9)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 9)
            .background(TwoWatchTheme.panelStrong, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(thread.scope.longLabel). Apri")
    }

    /// Seed corretto per livello: garantisce che il thread venga creato con il
    /// `contextId` giusto se l'utente entra prima che esista.
    private func seed(for thread: AppThread) -> PublicThreadSeed {
        switch thread.scope {
        case .season(let season):
            return .season(titleID: title.id, season: season)
        case .episode(let season, let episode):
            return .episode(titleID: title.id, season: season, episode: episode)
        case .title, .directMessage, .group:
            return .title(title.id)
        }
    }
}
