import Observation
import SwiftUI

@Observable
@MainActor
final class ProfileViewModel {
    private let watchlistRepository: any WatchlistRepositoryProtocol
    private let userRepository: any UserRepositoryProtocol
    private let titleRepository: any TitleRepositoryProtocol

    var watchedEntries: [LibraryEntry] = []
    var seriesProgress: [String: TitleSeriesProgress] = [:]
    var reviews: [ProfileReviewEntry] = []
    /// Emozioni + post pubblici del tab Attività, caricati lazy (vedi `loadActivityIfNeeded`).
    var emotions: [TitleEmotionEntry] = []
    /// Emozioni indicizzate per titolo, per il filtro del tab "Visti".
    /// `uniquingKeysWith` e non `uniqueKeysWithValues`: `titleId` non è la
    /// chiave del documento, quindi un duplicato non deve far crashare.
    var emotionsByTitleID: [String: [TitleEmotion]] {
        Dictionary(
            emotions.map { ($0.titleId, $0.emotions) },
            uniquingKeysWith: { first, _ in first }
        )
    }
    var posts: [AppPost] = []
    var hasLoadedActivity = false
    var isLoadingActivity = false
    var activitySummary: ProfileActivitySummary = .empty
    var reviewCount: Int = 0
    var followers: [AppUser] = []
    var following: [AppUser] = []
    var isLoading = false
    var errorMessage: String?
    var newSeasonHits: [NewSeasonDetectionItem] = []

    @ObservationIgnored private var lastNewSeasonsDetectionAt: Date?
    private static let newSeasonsDetectionMinInterval: TimeInterval = 60

    /// Niente `= TitleRepository()` come default: era un bypass di
    /// `AppContainer` (docs/IOS_REFACTOR_PLAN.md §2.2) e rendeva il ViewModel
    /// non istanziabile in un test.
    init(
        watchlistRepository: any WatchlistRepositoryProtocol,
        userRepository: any UserRepositoryProtocol,
        titleRepository: any TitleRepositoryProtocol
    ) {
        self.watchlistRepository = watchlistRepository
        self.userRepository = userRepository
        self.titleRepository = titleRepository
    }

    func detectNewSeasonsIfNeeded(userID: String) async {
        if let lastNewSeasonsDetectionAt,
           Date().timeIntervalSince(lastNewSeasonsDetectionAt) < Self.newSeasonsDetectionMinInterval {
            return
        }
        lastNewSeasonsDetectionAt = Date()
        do {
            let result = try await watchlistRepository.detectNewSeasonsForUser(userID: userID)
            newSeasonHits = result.detected
        } catch {
            // Detection è opzionale: non sovrascriviamo errori UI.
        }
    }

    func load(userID: String) async {
        isLoading = true
        errorMessage = nil
        reviewCount = 0
        // Il tab Attività (review + emozioni + post) è lazy: si resetta a ogni
        // reload completo (es. cambio account) e si ricarica alla prossima
        // selezione del tab via `loadActivityIfNeeded`.
        reviews = []
        emotions = []
        posts = []
        hasLoadedActivity = false
        defer { isLoading = false }

        async let libraryTask = watchlistRepository.fetchLibrary(userID: userID)
        async let seriesProgressTask = watchlistRepository.fetchPublicProfileSeriesProgress(userID: userID)
        async let followersTask = userRepository.listFollowers(userID: userID)
        async let followingTask = userRepository.listFollowing(userID: userID)
        // users/{uid} letto una volta sola: prima activity + review count lo
        // rileggevano entrambi internamente. Le task pesanti sopra sono già
        // partite, quindi nessuna serializzazione aggiunta. Se la lettura
        // fallisce (nil) i due helper rifanno il fallback interno come prima.
        // `let` e non `var`: sotto viene passato a degli `async let`, e una
        // variabile mutabile li' e' un invio fra domini di isolamento.
        //
        // Fallire qui non e' fatale — i due helper rifanno il fallback interno —
        // ma sono due letture Firestore in piu' a ogni apertura di profilo, ed
        // e' un costo che finora non si vedeva.
        let preloadedUser: AppUser?
        do {
            preloadedUser = try await userRepository.fetchUser(uid: userID)
        } catch {
            SilentFailure.record(error, context: "Profile.preloadedUser")
            preloadedUser = nil
        }
        async let activityTask = watchlistRepository.fetchProfileActivitySummary(userID: userID, preloadedUser: preloadedUser)
        async let reviewTask = watchlistRepository.fetchReviewCount(userID: userID, preloadedUser: preloadedUser)

        do {
            watchedEntries = sortedLibraryEntries(try await libraryTask)
        } catch {
            watchedEntries = []
            errorMessage = UserFacingError.message(for: error)
        }

        do { seriesProgress = try await seriesProgressTask } catch { SilentFailure.record(error, context: "Profile.seriesProgress"); seriesProgress = [:] }

        do {
            activitySummary = try await activityTask
        } catch {
            activitySummary = .empty
            if errorMessage == nil {
                errorMessage = UserFacingError.message(for: error)
            }
        }

        do { reviewCount = try await reviewTask } catch { SilentFailure.record(error, context: "Profile.reviewCount"); reviewCount = 0 }
        do { followers = try await followersTask } catch { SilentFailure.record(error, context: "Profile.followers"); followers = [] }
        do { following = try await followingTask } catch { SilentFailure.record(error, context: "Profile.following"); following = [] }
    }

    /// Carica review + emozioni + post pubblici una sola volta, alla prima
    /// selezione del tab Attività (`ProfileContentTab.reviews`).
    func loadActivityIfNeeded(userID: String) async {
        guard !hasLoadedActivity else { return }
        hasLoadedActivity = true
        isLoadingActivity = true
        defer { isLoadingActivity = false }

        async let reviewEntriesTask = watchlistRepository.fetchProfileReviews(userID: userID)
        async let emotionsTask = titleRepository.fetchMyEmotions(userID: userID)
        async let postsTask = watchlistRepository.fetchPublicPostsByAuthor(userID: userID)

        do { reviews = try await reviewEntriesTask } catch { SilentFailure.record(error, context: "Profile.reviews"); reviews = [] }
        do { emotions = try await emotionsTask } catch { SilentFailure.record(error, context: "Profile.emotions"); emotions = [] }
        do { posts = try await postsTask } catch { SilentFailure.record(error, context: "Profile.posts"); posts = [] }
        reviewCount = max(reviewCount, reviews.count)
    }

    private func sortedLibraryEntries(_ entries: [LibraryEntry]) -> [LibraryEntry] {
        entries.sorted { lhs, rhs in
            if lhs.activitySortDate != rhs.activitySortDate {
                return lhs.activitySortDate > rhs.activitySortDate
            }
            return lhs.titleId < rhs.titleId
        }
    }
}

struct ProfileView: View {
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore
    private let disablesAutomaticLoading: Bool
    @State private var viewModel: ProfileViewModel
    @State private var selectedTab: ProfileContentTab = .watched
    /// Filtro tipo (Film/Serie/Cartoni/Anime) condiviso: la strip-contatori nel
    /// blocco "Tempo di visione" lo pilota, il tab "Visti" lo consuma.
    @State private var watchedCategoryFilter: Set<ContentCategory> = []

    init(container: AppContainer, session: SessionStore, shell: AppShellStore) {
        self.container = container
        self.session = session
        self.shell = shell
        disablesAutomaticLoading = false
        _viewModel = State(initialValue: ProfileViewModel(
            watchlistRepository: container.watchlistRepository,
            userRepository: container.userRepository,
            titleRepository: container.titleRepository
        ))
    }

#if DEBUG
    init(
        container: AppContainer,
        session: SessionStore,
        shell: AppShellStore,
        previewViewModel: ProfileViewModel,
        previewSelectedTab: ProfileContentTab = .watched
    ) {
        self.container = container
        self.session = session
        self.shell = shell
        disablesAutomaticLoading = true
        _viewModel = State(initialValue: previewViewModel)
        _selectedTab = State(initialValue: previewSelectedTab)
    }
#endif

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Color.clear
                    .frame(height: 0)
                    .background(
                        GeometryReader { proxy in
                            let offset = max(0, -proxy.frame(in: .named("profile-scroll")).minY)
                            Color.clear
                                .preference(key: ChromeBarCompactPreferenceKey.self, value: offset > 0)
                                .preference(key: ChromeBarMinimalPreferenceKey.self, value: offset > 60)
                        }
                    )

                if let user = session.appUser {
                    ProfileTopHeader(
                        container: container,
                        session: session,
                        shell: shell,
                        user: user,
                        followers: viewModel.followers,
                        following: viewModel.following,
                        watchedCount: viewModel.activitySummary.watchedTitlesCount,
                        reviewCount: effectiveReviewCount(for: user)
                    )
                    .padding(.horizontal, 14)

                    ProfileActivitySummarySection(
                        activitySummary: viewModel.activitySummary,
                        reviewCount: effectiveReviewCount(for: user),
                        isLoading: viewModel.isLoading,
                        user: user,
                        onImportRequested: {
                            shell.activePresentedDestination = .titlesImport(importId: nil)
                        },
                        categoryCounts: profileWatchedCategoryCounts(viewModel.watchedEntries),
                        categoryFilterSelection: $watchedCategoryFilter,
                        onCategoryFilterSelected: { _ in
                            if selectedTab != .watched {
                                withAnimation(.easeInOut(duration: 0.2)) { selectedTab = .watched }
                            }
                        }
                    )
                    .padding(.horizontal, 14)

                    VStack(alignment: .leading, spacing: 18) {
                        ProfileContentTabs(selection: $selectedTab)

                        profileContent(for: user)
                    }
                    .padding(16)
                    .background(
                        RoundedRectangle(cornerRadius: 28, style: .continuous)
                            .fill(Color.white)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 28, style: .continuous)
                            .stroke(Color.black.opacity(0.06), lineWidth: 1)
                    )
                    .shadow(color: .black.opacity(0.10), radius: 16, y: 8)
                    .padding(.horizontal, 14)
                } else {
                    EmptyStateView(
                        title: "Profilo non disponibile",
                        message: "La sezione profilo usa `users` e la watchlist privata: serve login per proseguire.",
                        systemImage: "person.crop.circle.badge.exclamationmark",
                        actionTitle: "Accedi"
                    ) {
                        shell.presentAuth()
                    }
                    .padding(14)
                }
            }
            .padding(.top, 48)
            .padding(.bottom, 20)
        }
        .background(TwoWatchBackground())
        .coordinateSpace(name: "profile-scroll")
        .scrollIndicators(.hidden)
        .toolbar(.hidden, for: .navigationBar)
        // Ricarica dati quando cambia l'uid (es. logout + login in-app)
        .task(id: session.firebaseUser?.uid) {
            guard !disablesAutomaticLoading else { return }
            if let uid = session.firebaseUser?.uid {
                await viewModel.load(userID: uid)
                await viewModel.detectNewSeasonsIfNeeded(userID: uid)
            }
        }
        .onChange(of: selectedTab) { _, newTab in
            // Anche Visti serve le emozioni, per il filtro "Emozione".
            guard !disablesAutomaticLoading,
                  newTab == .reviews || newTab == .watched,
                  let uid = session.firebaseUser?.uid
            else { return }
            Task { await viewModel.loadActivityIfNeeded(userID: uid) }
        }
        .alert("Errore", isPresented: Binding(get: { viewModel.errorMessage != nil }, set: { _ in viewModel.errorMessage = nil })) {
            Button("Chiudi", role: .cancel) {}
        } message: {
            Text(viewModel.errorMessage ?? "")
        }
    }

    @ViewBuilder
    private func profileContent(for user: AppUser) -> some View {
        switch selectedTab {
        case .watched:
            ProfileWatchedTitlesSection(
                container: container,
                session: session,
                shell: shell,
                entries: viewModel.watchedEntries,
                seriesProgress: viewModel.seriesProgress,
                selectedCategories: $watchedCategoryFilter,
                emotionsByTitleID: viewModel.emotionsByTitleID,
                isLoading: viewModel.isLoading,
                embedsInCard: false,
                isOwnProfile: true,
                onLibraryChanged: {
                    if let uid = session.firebaseUser?.uid {
                        Task { await viewModel.load(userID: uid) }
                    }
                }
            )
        case .reviews:
            ProfileReviewsSection(
                container: container,
                session: session,
                shell: shell,
                reviews: viewModel.reviews,
                emotions: viewModel.emotions,
                posts: viewModel.posts,
                isLoading: viewModel.isLoadingActivity,
                embedsInCard: false
            )
        case .taste:
            ProfileTasteSection(
                container: container,
                session: session,
                shell: shell,
                favoriteGenres: user.favoriteGenres,
                entries: viewModel.watchedEntries,
                embedsInCard: false
            )
        }
    }

    private func effectiveReviewCount(for user: AppUser) -> Int {
        max(viewModel.reviewCount, user.stats.reviewsCount)
    }
}

#if DEBUG
private struct ProfileViewRuntimePreview: View {
    let session: SessionStore
    let viewModel: ProfileViewModel
    let selectedTab: ProfileContentTab
    @State private var shell = TwoWatchPreview.shell(selectedTab: .profile)

    var body: some View {
        TabView(selection: $shell.selectedTab) {
            Color.clear
                .tabItem { Label("Home", systemImage: "house.fill") }
                .tag(AppTab.home)

            Color.clear
                .tabItem { Label("Community", systemImage: "person.2.fill") }
                .tag(AppTab.community)

            Color.clear
                .tabItem { Label("Watchlist", systemImage: "bookmark.fill") }
                .tag(AppTab.watchlist)

            Color.clear
                .tabItem { Label("Quiz", systemImage: "questionmark.circle.fill") }
                .tag(AppTab.quiz)

            NavigationStack {
                ProfileView(
                    container: TwoWatchPreview.container,
                    session: session,
                    shell: shell,
                    previewViewModel: viewModel,
                    previewSelectedTab: selectedTab
                )
            }
            .brandChromePill(shell: shell)
            .tabItem { Label("Profilo", systemImage: "person.crop.circle.fill") }
            .tag(AppTab.profile)
        }
        .toolbarBackground(.visible, for: .tabBar)
        .toolbarBackground(TwoWatchTheme.tabMaterial, for: .tabBar)
        .toolbarColorScheme(.dark, for: .tabBar)
    }
}

#Preview("Profilo · Visti", traits: .fixedLayout(width: 393, height: 852)) {
    ProfileViewRuntimePreview(
        session: TwoWatchPreview.session(),
        viewModel: TwoWatchPreview.profileViewModel(),
        selectedTab: .watched
    )
}

#Preview("Profilo · Review", traits: .fixedLayout(width: 393, height: 852)) {
    ProfileViewRuntimePreview(
        session: TwoWatchPreview.session(),
        viewModel: TwoWatchPreview.profileViewModel(),
        selectedTab: .reviews
    )
}

#Preview("Profilo · Taste", traits: .fixedLayout(width: 393, height: 852)) {
    ProfileViewRuntimePreview(
        session: TwoWatchPreview.session(),
        viewModel: TwoWatchPreview.profileViewModel(),
        selectedTab: .taste
    )
}
#endif
