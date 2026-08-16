@preconcurrency import FirebaseFirestore
import Observation
import SwiftUI
import UIKit

/// View model della tab **Community**: feed sociale ordinato per rilevanza.
/// Mescola l'attività di chi segui (grafo follow, via `HomeRepository.fetchFeed`)
/// e TUTTI i post pubblici (via `PostsRepository.listPublicPostsPage`), con
/// ranking popolarità×recency (`CommunityFeedRanking`) — così anche un utente
/// con zero follow vede contenuti. Il composer vive qui insieme al feed.
struct CommunityView: View {
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore
    private let disablesAutomaticLoading: Bool
    @State private var viewModel: CommunityViewModel
    @State private var communityScrollOffset: CGFloat = 0
    @State private var isThreadExplorerPresented = false

    init(container: AppContainer, session: SessionStore, shell: AppShellStore) {
        self.container = container
        self.session = session
        self.shell = shell
        disablesAutomaticLoading = false
        _viewModel = State(initialValue: CommunityViewModel(
            homeRepository: container.homeRepository,
            postsRepository: container.postsRepository,
            threadsRepository: container.threadsRepository,
            watchlistRepository: container.watchlistRepository
        ))
    }

#if DEBUG
    init(
        container: AppContainer,
        session: SessionStore,
        shell: AppShellStore,
        previewViewModel: CommunityViewModel,
        previewScrollOffset: CGFloat = 0
    ) {
        self.container = container
        self.session = session
        self.shell = shell
        disablesAutomaticLoading = true
        _viewModel = State(initialValue: previewViewModel)
        _communityScrollOffset = State(initialValue: previewScrollOffset)
    }
#endif

    var body: some View {
        ScrollViewReader { scrollProxy in
            ScrollView {
                VStack(spacing: 18) {
                    Color.clear
                        .frame(height: 0)
                        .id("community-top")
                        .background(
                            GeometryReader { proxy in
                                let offset = max(0, -proxy.frame(in: .named("community-scroll")).minY)
                                Color.clear
                                    .preference(key: HomeScrollOffsetPreferenceKey.self, value: offset)
                                    .preference(key: ChromeBarCompactPreferenceKey.self, value: offset > 0)
                                    .preference(key: ChromeBarMinimalPreferenceKey.self, value: offset > 60)
                            }
                        )

                    // Ordine come community.html: #discussionStarter ("Apri una
                    // discussione") è il primo elemento del DOM, prima di
                    // #communityThreads → stesso ordine qui. Solo autenticati (i
                    // guest non possono creare thread né postare).
                    if session.isAuthenticated {
                        CommunityDiscussionStarterCard(container: container, session: session, shell: shell)
                            .padding(.horizontal, 14)
                    }

                    // Ordine come community.html: #communityThreads ("Discussioni per
                    // te") viene PRIMA di #composer nel DOM web → stesso ordine qui.
                    // La sezione resta montata anche senza suggerimenti: l'empty
                    // state e la porta "Esplora tutti i thread" sono il punto.
                    if session.isAuthenticated {
                        CommunityDiscussionsSection(
                            suggestions: viewModel.discussions,
                            hasLibrarySignals: viewModel.hasLibrarySignals,
                            onOpenThread: { threadID in
                                shell.activePresentedSheet = .thread(id: threadID)
                            },
                            onExploreThreads: { isThreadExplorerPresented = true },
                            onSearchTitles: { shell.presentSearch() }
                        )
                        .padding(.horizontal, 14)
                    }

                    if showsComposer {
                        topComposerSection
                            .padding(.horizontal, 14)
                            .transition(.move(edge: .top).combined(with: .opacity))
                    }

                    VStack(spacing: 14) {
                        if let errorMessage = viewModel.errorMessage, !viewModel.isLoading {
                            HomeErrorBanner(message: errorMessage) {
                                Task { await viewModel.reload(userID: session.firebaseUser?.uid) }
                            }
                            .transition(.opacity.combined(with: .move(edge: .top)))
                            .animation(.easeInOut(duration: 0.2), value: viewModel.errorMessage)
                        }

                        if viewModel.isLoading {
                            HomeFeedSkeleton()
                                .padding(.top, 4)
                        } else if feedItems.isEmpty {
                            EmptyStateView(
                                title: "Ancora nessuna discussione",
                                message: "Qui trovi i post della community e di chi segui. Pubblica il primo o segui qualcuno per animare il feed.",
                                systemImage: "rectangle.on.rectangle.angled",
                                actionTitle: "Esplora titoli"
                            ) {
                                shell.presentSearch()
                            }
                            .padding(.top, 12)
                        } else {
                            LazyVStack(spacing: 18) {
                                ForEach(feedItems) { activity in
                                    Group {
                                        if activity.kind == .titleComment {
                                            CommunityCommentCard(
                                                activity: activity,
                                                progressEntry: activity.titleId.flatMap { viewModel.progressByTitleID[$0] },
                                                container: container,
                                                session: session,
                                                shell: shell
                                            )
                                        } else {
                                            FeedActivityCard(
                                                activity: activity,
                                                container: container,
                                                session: session,
                                                shell: shell,
                                                allowsLiveSocialLoad: !disablesAutomaticLoading
                                            )
                                        }
                                    }
                                    .onAppear {
                                        guard !disablesAutomaticLoading,
                                              activity.id == feedItems.last?.id,
                                              let userID = session.firebaseUser?.uid
                                        else { return }
                                        Task { await viewModel.loadMore(userID: userID) }
                                    }
                                }

                                if viewModel.canLoadMore {
                                    if viewModel.isLoadingMore {
                                        HStack(spacing: 10) {
                                            ProgressView().tint(TwoWatchTheme.brandPrimary)
                                            Text("Carico altri post...")
                                                .font(.footnote.weight(.semibold))
                                                .foregroundStyle(TwoWatchTheme.textSecondary)
                                        }
                                        .frame(maxWidth: .infinity)
                                        .padding(.vertical, 12)
                                    } else if let userID = session.firebaseUser?.uid {
                                        Button {
                                            Task { await viewModel.loadMore(userID: userID) }
                                        } label: {
                                            Text("Carica altri post")
                                                .frame(maxWidth: .infinity)
                                        }
                                        .buttonStyle(PrimaryButtonStyle())
                                    }
                                }
                            }
                        }
                    }
                    .padding(.horizontal, 14)
                }
                .padding(.top, 48)
                .padding(.bottom, 16)
                .simultaneousGesture(TapGesture().onEnded {
                    dismissKeyboard()
                })
            }
            .background(TwoWatchBackground())
            .coordinateSpace(name: "community-scroll")
            .scrollIndicators(.hidden)
            .scrollDismissesKeyboard(.interactively)
            .toolbar(.hidden, for: .navigationBar)
            .onPreferenceChange(HomeScrollOffsetPreferenceKey.self, perform: handleScrollChange)
            .animation(.easeInOut(duration: 0.22), value: showsComposer)
            .task(id: session.firebaseUser?.uid) {
                guard !disablesAutomaticLoading else { return }
                await viewModel.load(userID: session.firebaseUser?.uid)
            }
            // Task separato, non in coda al feed: il bottone "Segui" delle card
            // deve nascere gia' nello stato giusto, e la sua query e' una sola
            // per schermata (non una per card).
            .task(id: session.firebaseUser?.uid) {
                guard !disablesAutomaticLoading else { return }
                await container.titleFollowStore.load(userID: session.firebaseUser?.uid)
            }
            .refreshable {
                guard !disablesAutomaticLoading else { return }
                await viewModel.reload(userID: session.firebaseUser?.uid)
            }
            .onChange(of: shell.socialRefreshToken) {
                guard !disablesAutomaticLoading else { return }
                Task { await viewModel.reload(userID: session.firebaseUser?.uid) }
            }
            .sheet(isPresented: $isThreadExplorerPresented) {
                ThreadExplorerView(container: container, session: session, shell: shell)
            }
        }
    }

    private var feedItems: [FeedActivity] {
        // Guideline 1.2: i contenuti degli utenti bloccati spariscono
        // subito dal feed del bloccante (cache di sessione, niente refetch).
        viewModel.feed.filter { session.blockedUserIDs.contains($0.actor.id) == false }
    }

    private var showsComposer: Bool {
        communityScrollOffset <= 12
    }

    @ViewBuilder
    private var topComposerSection: some View {
        if session.isAuthenticated {
            HomeComposerCard(container: container, session: session, shell: shell) { _ in
                await viewModel.reload(userID: session.firebaseUser?.uid)
            }
        } else {
            guestComposerState
        }
    }

    private var guestComposerState: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Accedi per pubblicare")
                .font(.headline.weight(.bold))
                .foregroundStyle(TwoWatchTheme.textPrimary)
            Text("La community vive di feed e conversazioni: per postare o interagire serve la sessione.")
                .font(.subheadline)
                .foregroundStyle(TwoWatchTheme.textSecondary)
            Button("Accedi") {
                shell.presentAuth()
            }
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(Color.black, in: Capsule())
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(TwoWatchTheme.panel, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .stroke(TwoWatchTheme.border, lineWidth: 1)
        )
    }

    private func handleScrollChange(_ rawValue: CGFloat) {
        communityScrollOffset = max(0, rawValue)
    }
}

// MARK: - Discussioni per te

/// Modulo "Discussioni per te": righe di thread pubblici rilevanti per i gusti
/// dell'utente. Il tap apre il thread (sheet, pattern esistente).
/// Layout mirror di `.home-disc-section` (home.css): header SENZA card
/// (niente pannello dietro il titolo), poi una lista di `.threadcard`
/// individuali (ognuna la propria card), gap `--space-sm` (12pt) tra righe.
#if DEBUG
#Preview("Community Feed") {
    CommunityViewRuntimePreview(
        session: TwoWatchPreview.session(),
        viewModel: TwoWatchPreview.communityViewModel()
    )
}

private struct CommunityViewRuntimePreview: View {
    let session: SessionStore
    let viewModel: CommunityViewModel
    @State private var shell = TwoWatchPreview.shell(selectedTab: .community)

    var body: some View {
        TabView(selection: $shell.selectedTab) {
            Color.clear
                .tabItem { Label("Home", systemImage: "house.fill") }
                .tag(AppTab.home)

            NavigationStack {
                CommunityView(
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
#endif
