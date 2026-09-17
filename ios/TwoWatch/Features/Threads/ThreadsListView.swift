@preconcurrency import FirebaseFirestore
import Observation
import SwiftUI

enum ThreadsTab: String, CaseIterable, Identifiable {
    case messages = "Chat"
    case groups = "Gruppi"
    case support = "Assistenza"
    case discussions = "Seguite"

    var id: String { rawValue }

    var symbolName: String {
        switch self {
        case .discussions: return "bubble.left.and.bubble.right.fill"
        case .messages: return "paperplane.fill"
        case .groups: return "person.2.fill"
        case .support: return "questionmark.bubble.fill"
        }
    }
}

@Observable
@MainActor
final class ThreadsListViewModel {
    private let repository: ThreadsRepository
    @ObservationIgnored private var myCursor: DocumentSnapshot?

    var myThreads: [AppThread] = []
    /// Discussioni pubbliche che l'utente **segue davvero**: quelle che ha
    /// aperto almeno una volta (registrate localmente da `markThreadRead`) più
    /// quelle in cui risulta partecipante.
    ///
    /// Prima qui finivano i 40 thread pubblici più recenti dell'intera app,
    /// senza alcun filtro: era da lì che "Messaggi" mostrava discussioni su
    /// titoli mai visti né cercati. La scoperta è compito della Community; qui
    /// si ritrova solo ciò che è già tuo.
    var followedThreads: [AppThread] = []
    var selectedTab: ThreadsTab = .messages
    var isLoading = false
    var isLoadingMore = false
    var errorMessage: String?
    var hasMoreMyThreads = false

    init(repository: ThreadsRepository) {
        self.repository = repository
    }

    func load(currentUserID: String) async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        do {
            let myPage = try await repository.listMyThreadsPage(uid: currentUserID)
            myThreads = myPage.items
            myCursor = myPage.nextCursor
            hasMoreMyThreads = myPage.hasMore

            // Discussioni pubbliche seguite: id noti localmente + eventuali
            // pubbliche in cui compare fra i partecipanti.
            let knownIDs = repository.knownThreadIDs()
            let alreadyLoaded = Set(myPage.items.map(\.id))
            let missing = knownIDs.filter { !alreadyLoaded.contains($0) }
            let fetched = (try? await repository.listPublicThreadsByIDs(missing)) ?? []

            var pool: [String: AppThread] = [:]
            for thread in fetched where thread.isPublic { pool[thread.id] = thread }
            for thread in myPage.items where thread.isPublic { pool[thread.id] = thread }
            followedThreads = Array(pool.values)
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }

    func loadMore(currentUserID: String) async {
        guard !isLoadingMore, selectedTab != .discussions, hasMoreMyThreads else { return }
        isLoadingMore = true
        defer { isLoadingMore = false }

        do {
            let page = try await repository.listMyThreadsPage(uid: currentUserID, after: myCursor)
            myThreads.append(contentsOf: page.items)
            myCursor = page.nextCursor
            hasMoreMyThreads = page.hasMore
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }

    func threads(for tab: ThreadsTab) -> [AppThread] {
        switch tab {
        case .discussions:
            return sorted(followedThreads)
        case .messages:
            return sorted(myThreads.filter { !$0.isPublic && $0.contextType == .dm })
        case .groups:
            return sorted(myThreads.filter { !$0.isPublic && $0.contextType == .group && !isSupportThread($0) })
        case .support:
            return sorted(myThreads.filter(isSupportThread))
        }
    }

    func canLoadMore(tab: ThreadsTab) -> Bool {
        switch tab {
        // Le discussioni seguite sono un insieme chiuso (gli id già noti):
        // non c'è una pagina successiva da caricare.
        case .discussions: return false
        case .messages, .groups, .support: return hasMoreMyThreads
        }
    }

    func unreadCount(tab: ThreadsTab) -> Int {
        threads(for: tab).filter { repository.isUnread($0) }.count
    }

    func isUnread(_ thread: AppThread) -> Bool {
        repository.isUnread(thread)
    }

    private func sorted(_ threads: [AppThread]) -> [AppThread] {
        threads.sorted { lhs, rhs in
            let left = lhs.lastMessageAt ?? lhs.createdAt ?? .distantPast
            let right = rhs.lastMessageAt ?? rhs.createdAt ?? .distantPast
            return left > right
        }
    }

    private func isSupportThread(_ thread: AppThread) -> Bool {
        thread.contextType == .group && (thread.contextId ?? "").hasPrefix("support_")
    }
}

struct ThreadsListView: View {
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore

    @State private var viewModel: ThreadsListViewModel
    @State private var isFabMenuPresented = false

    init(container: AppContainer, session: SessionStore, shell: AppShellStore) {
        self.container = container
        self.session = session
        self.shell = shell
        _viewModel = State(initialValue: ThreadsListViewModel(repository: container.threadsRepository))
    }

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if !session.isAuthenticated {
                        EmptyStateView(
                            title: "Threads privati",
                            message: "Accedi per vedere discussioni pubbliche, gruppi e DM legati ai titoli del catalogo Somto.",
                            systemImage: "bubble.left.and.bubble.right.fill",
                            actionTitle: "Accedi"
                        ) { shell.presentAuth() }
                    } else {
                        pageHeader
                        tabsControl
                        contentForSelectedTab
                    }
                }
                .padding(.horizontal, 20)
                .padding(.top, 4)
                .padding(.bottom, 110)
            }
            .safeAreaInset(edge: .top, spacing: 0) {
                threadsTopChrome
            }
            .background(TwoWatchBackground())
            .navigationTitle("")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar(.hidden, for: .navigationBar)
            .task(id: session.firebaseUser?.uid) {
                if let uid = session.firebaseUser?.uid {
                    await viewModel.load(currentUserID: uid)
                    shell.threadUnreadCount = viewModel.threads(for: .messages).filter { viewModel.isUnread($0) }.count
                        + viewModel.threads(for: .groups).filter { viewModel.isUnread($0) }.count
                        + viewModel.threads(for: .support).filter { viewModel.isUnread($0) }.count
                }
            }
            .refreshable {
                if let uid = session.firebaseUser?.uid {
                    await viewModel.load(currentUserID: uid)
                }
            }
            .alert("Errore", isPresented: Binding(get: { viewModel.errorMessage != nil }, set: { _ in viewModel.errorMessage = nil })) {
                Button("Chiudi", role: .cancel) {}
            } message: {
                Text(viewModel.errorMessage ?? "")
            }

            if session.isAuthenticated {
                fabButton
                    .padding(.trailing, 22)
                    .padding(.bottom, 32)
            }
        }
        .confirmationDialog(
            "Crea",
            isPresented: $isFabMenuPresented,
            titleVisibility: .visible
        ) {
            Button("Nuova discussione pubblica") { shell.presentSearch() }
            Button("Nuovo messaggio") { shell.presentSearch() }
            Button("Nuovo gruppo") { shell.presentSearch() }
            Button("Annulla", role: .cancel) {}
        } message: {
            Text("Scegli cosa vuoi creare. Ti porto sul titolo da cui far partire la chat.")
        }
    }

    // MARK: - Persistent top chrome (Somto pill with dismiss + search)

    @Environment(\.dismiss) private var dismissModal

    private var threadsTopChrome: some View {
        HStack(spacing: 8) {
            Button {
                dismissModal()
            } label: {
                Image(systemName: "xmark")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(Color.black)
                    .frame(width: 38, height: 38)
                    .background(Color.black.opacity(0.05), in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Chiudi")

            BrandWordmarkView(width: 110)

            Spacer(minLength: 0)

            Button {
                shell.presentSearch()
            } label: {
                Image(systemName: "magnifyingglass")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(Color.black)
                    .frame(width: 38, height: 38)
                    .background(Color.black.opacity(0.05), in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Cerca")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(Color.white, in: RoundedRectangle(cornerRadius: 30, style: .continuous))
        .shadow(color: Color.black.opacity(0.16), radius: 24, x: 0, y: 12)
        .padding(.horizontal, 14)
        .padding(.top, 10)
        .padding(.bottom, 12)
    }

    // MARK: - Page title row

    private var pageHeader: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Messaggi")
                .font(.system(size: 34, weight: .black, design: .rounded))
                .foregroundStyle(TwoWatchTheme.textPrimary)
            // Dice esplicitamente qual è il confine con la Community: qui si
            // ritrova, là si scopre.
            Text("Le tue conversazioni. Per scoprirne di nuove vai in Community.")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(TwoWatchTheme.textMuted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var tabsControl: some View {
        HStack(spacing: 0) {
            ForEach(ThreadsTab.allCases) { tab in
                let isActive = viewModel.selectedTab == tab
                Button {
                    withAnimation(.easeInOut(duration: 0.15)) { viewModel.selectedTab = tab }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: tab.symbolName)
                            .font(.caption.weight(.semibold))
                        Text(tab.rawValue)
                            .font(.caption.weight(.semibold))
                    }
                    .foregroundStyle(isActive ? Color.black : TwoWatchTheme.textPrimary)
                    .padding(.vertical, 10)
                    .frame(maxWidth: .infinity)
                    .background(
                        isActive ? AnyShapeStyle(TwoWatchTheme.accent) : AnyShapeStyle(Color.clear),
                        in: Capsule()
                    )
                }
                .buttonStyle(.plain)

                if tab != ThreadsTab.allCases.last {
                    Divider()
                        .frame(height: 16)
                        .overlay(TwoWatchTheme.border)
                        .opacity(isActive || viewModel.selectedTab == nextTab(after: tab) ? 0 : 1)
                }
            }
        }
        .padding(4)
        .background(TwoWatchTheme.panel, in: Capsule())
        .overlay(Capsule().stroke(TwoWatchTheme.border, lineWidth: 1))
    }

    private func nextTab(after tab: ThreadsTab) -> ThreadsTab? {
        guard let idx = ThreadsTab.allCases.firstIndex(of: tab),
              idx + 1 < ThreadsTab.allCases.count else { return nil }
        return ThreadsTab.allCases[idx + 1]
    }

    // MARK: - Content per tab

    @ViewBuilder
    private var contentForSelectedTab: some View {
        let threads = viewModel.threads(for: viewModel.selectedTab)
        let label = sectionLabel(for: viewModel.selectedTab)
        VStack(alignment: .leading, spacing: 12) {
            Text(label)
                .font(.system(size: 11, weight: .heavy, design: .rounded))
                .tracking(0.6)
                .foregroundStyle(TwoWatchTheme.textMuted)
                .padding(.top, 4)

            if viewModel.isLoading && threads.isEmpty {
                ProgressView().tint(TwoWatchTheme.accent).frame(maxWidth: .infinity).padding(.vertical, 30)
            } else if threads.isEmpty {
                emptyStateForTab(viewModel.selectedTab)
            } else {
                LazyVStack(spacing: 12) {
                    ForEach(threads) { thread in
                        NavigationLink {
                            ThreadDetailView(container: container, session: session, shell: shell, threadID: thread.id)
                        } label: {
                            ThreadCardView(
                                thread: thread,
                                tab: viewModel.selectedTab,
                                isUnread: viewModel.isUnread(thread),
                                currentUserID: session.firebaseUser?.uid
                            )
                        }
                        .buttonStyle(.plain)
                    }

                    if let uid = session.firebaseUser?.uid, viewModel.canLoadMore(tab: viewModel.selectedTab) {
                        Button {
                            Task { await viewModel.loadMore(currentUserID: uid) }
                        } label: {
                            if viewModel.isLoadingMore {
                                ProgressView().tint(TwoWatchTheme.accent)
                                    .frame(maxWidth: .infinity, minHeight: 38)
                            } else {
                                Text("Carica altri")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(TwoWatchTheme.accent)
                                    .frame(maxWidth: .infinity, minHeight: 38)
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    private func sectionLabel(for tab: ThreadsTab) -> String {
        switch tab {
        case .discussions: return String(localized: "DISCUSSIONI CHE SEGUI")
        case .messages: return "MESSAGGI DIRETTI"
        case .groups: return "GRUPPI"
        case .support: return "ASSISTENZA"
        }
    }

    @ViewBuilder
    private func emptyStateForTab(_ tab: ThreadsTab) -> some View {
        switch tab {
        case .discussions:
            EmptyStateView(
                title: "Nessuna discussione seguita",
                message: "Qui tornano le discussioni pubbliche che apri. Trovane una dalla Community o dalla scheda di un titolo.",
                systemImage: "bubble.left.and.bubble.right"
            )
        case .messages:
            EmptyStateView(
                title: "Nessun messaggio",
                message: "Invia un suggerimento o avvia una chat 1:1 da una scheda titolo per popolare questa sezione.",
                systemImage: "paperplane"
            )
        case .groups:
            EmptyStateView(
                title: "Nessun gruppo",
                message: "Crea un gruppo dalla scheda di un titolo per parlarne con i tuoi amici.",
                systemImage: "person.2"
            )
        case .support:
            EmptyStateView(
                title: "Nessuna richiesta di assistenza",
                message: "Apri il Centro assistenza per iniziare una conversazione.",
                systemImage: "questionmark.bubble"
            )
        }
    }

    // MARK: - FAB

    private var fabButton: some View {
        Button {
            isFabMenuPresented = true
        } label: {
            Image(systemName: "plus")
                .font(.title2.weight(.heavy))
                .foregroundStyle(Color.black)
                .frame(width: 58, height: 58)
                .background(TwoWatchTheme.accent, in: Circle())
                .shadow(color: TwoWatchTheme.accent.opacity(0.45), radius: 18, x: 0, y: 8)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Crea")
    }
}

// MARK: - Card

private struct ThreadCardView: View {
    let thread: AppThread
    let tab: ThreadsTab
    let isUnread: Bool
    let currentUserID: String?

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            posterOrAvatar

            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(thread.displayName(currentUserID: currentUserID))
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    if isUnread {
                        Circle()
                            .fill(TwoWatchTheme.accent)
                            .frame(width: 8, height: 8)
                    }
                }

                badgesRow

                if !preview.text.isEmpty {
                    Text(preview.text)
                        .font(.caption)
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                }

                HStack(spacing: 8) {
                    avatarsCluster

                    Spacer(minLength: 0)

                    if let date = thread.lastMessageAt ?? thread.createdAt {
                        Text(date.formatted(date: .abbreviated, time: .shortened))
                            .font(.caption2)
                            .foregroundStyle(TwoWatchTheme.textMuted)
                            .monospacedDigit()
                    }
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.textMuted)
                }
            }
        }
        .padding(14)
        .background(TwoWatchTheme.panel, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(TwoWatchTheme.border, lineWidth: 1)
        )
    }

    private var posterOrAvatar: some View {
        ZStack(alignment: .bottomLeading) {
            if let posterURL = thread.title?.posterPath {
                PosterImageView(url: posterURL, width: 56, height: 80, cornerRadius: 12)
            } else {
                ZStack {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(TwoWatchTheme.panelStrong)
                    Image(systemName: scope.symbolName)
                        .font(.title3.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                }
                .frame(width: 56, height: 80)
            }

            // Pastiglia d'angolo sulla locandina: distingue a colpo d'occhio
            // una chat da un gruppo da una discussione (e, per le discussioni,
            // di quale livello) anche scorrendo veloce.
            Text(cornerBadgeText)
                .font(.caption2.weight(.heavy))
                .foregroundStyle(.white)
                .padding(.horizontal, 6)
                .padding(.vertical, 3)
                .background(scope.tint.opacity(0.9), in: Capsule())
                .padding(4)
        }
    }

    /// Ambito reale della conversazione, non la tab da cui la si guarda: una
    /// discussione di episodio resta "S3 · E7" ovunque compaia.
    private var scope: ThreadScope { thread.scope }

    /// Anteprima già separata dal voto: i messaggi nati da un voto sono salvati
    /// come "7.5/10 — testo" e qui il numero diventa un badge ★, come sul web.
    private var preview: (score: String?, text: String) {
        thread.previewSplit
    }

    private var cornerBadgeText: String {
        if isSupportThread { return "Assistenza" }
        switch scope {
        case .directMessage: return "DM"
        case .group: return "Gruppo"
        case .title: return "Serie"
        case .season(let season): return "S\(season)"
        case .episode(let season, let episode): return "S\(season)E\(episode)"
        }
    }

    private var badgesRow: some View {
        HStack(spacing: 6) {
            if isSupportThread {
                Label("Assistenza", systemImage: "questionmark.bubble.fill")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.textSecondary)
            } else {
                ThreadScopeBadge(scope: scope, compact: true)
            }
            if let score = preview.score {
                ThreadRatingBadge(score: score)
            }
            Spacer(minLength: 0)
        }
    }

    private var isSupportThread: Bool {
        thread.contextType == .group && (thread.contextId ?? "").hasPrefix("support_")
    }

    private var avatarsCluster: some View {
        let users = thread.participantUsers.filter { $0.id != currentUserID }
        let visible = users.prefix(3)
        let extra = max(0, users.count - visible.count)
        return HStack(spacing: -8) {
            ForEach(Array(visible.enumerated()), id: \.element.id) { _, user in
                avatar(user: user)
            }
            if extra > 0 {
                Text("+\(extra)")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 4)
                    .background(TwoWatchTheme.panelStrong, in: Capsule())
                    .overlay(Capsule().stroke(TwoWatchTheme.border, lineWidth: 1))
                    .padding(.leading, 12)
            }
        }
    }

    private func avatar(user: AppUser) -> some View {
        // Il bordo qui e' del COLORE DI SFONDO, non del bordo di sistema:
        // serve a staccare gli avatar sovrapposti in pila, quindi resta
        // fuori da SomtoAvatar.
        SomtoAvatar(url: user.photoURL ?? user.avatarURL, name: user.displayName, size: 22)
            .overlay(Circle().stroke(TwoWatchTheme.background, lineWidth: 2))
    }
}
