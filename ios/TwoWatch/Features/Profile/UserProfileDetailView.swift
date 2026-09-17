import Observation
import SwiftUI

@Observable
@MainActor
final class UserProfileDetailViewModel {
    private let userID: String
    private let userRepository: UserRepository
    private let watchlistRepository: WatchlistRepository
    private let threadsRepository: ThreadsRepository
    private let titleRepository: TitleRepository

    var user: AppUser?
    var relationship: UserRelationshipState?
    var activitySummary: ProfileActivitySummary = .empty
    var reviewCount: Int = 0
    var reviews: [ProfileReviewEntry] = []
    /// Emozioni + post pubblici del tab Attività, caricati lazy (vedi `loadActivityIfNeeded`).
    var emotions: [TitleEmotionEntry] = []
    var posts: [AppPost] = []
    var hasLoadedActivity = false
    var isLoadingActivity = false
    var watchedEntries: [LibraryEntry] = []
    var seriesProgress: [String: TitleSeriesProgress] = [:]
    var followers: [AppUser] = []
    var following: [AppUser] = []
    var currentViewerID: String?
    var isLoading = false
    var isUpdating = false
    var isOpeningChat = false
    var errorMessage: String?
    var successMessage: String?

    init(
        userID: String,
        userRepository: UserRepository,
        watchlistRepository: WatchlistRepository,
        threadsRepository: ThreadsRepository,
        /// Niente default `TitleRepository()`: era un bypass di `AppContainer`
        /// (docs/IOS_REFACTOR_PLAN.md §2.2), cioe' una seconda istanza con
        /// cache proprie accanto a quella condivisa.
        titleRepository: TitleRepository
    ) {
        self.userID = userID
        self.userRepository = userRepository
        self.watchlistRepository = watchlistRepository
        self.threadsRepository = threadsRepository
        self.titleRepository = titleRepository
    }

    var isOwnProfile: Bool {
        guard let currentViewerID else { return false }
        return currentViewerID == userID
    }

    /// Emozioni indicizzate per titolo, per il filtro del tab "Visti".
    /// `uniquingKeysWith` e non `uniqueKeysWithValues`: `titleId` qui non è la
    /// chiave del documento (l'id è `uid__titleId__...`), quindi un duplicato
    /// è possibile e farebbe crashare la variante stretta.
    var emotionsByTitleID: [String: [TitleEmotion]] {
        Dictionary(
            emotions.map { ($0.titleId, $0.emotions) },
            uniquingKeysWith: { first, _ in first }
        )
    }

    func load(viewerID: String?) async {
        currentViewerID = viewerID
        isLoading = true
        errorMessage = nil
        reviewCount = 0
        // Il tab Attività (review + emozioni + post) è lazy: si resetta a ogni
        // reload completo e si ricarica alla prossima selezione del tab via
        // `loadActivityIfNeeded`.
        reviews = []
        emotions = []
        posts = []
        hasLoadedActivity = false
        defer { isLoading = false }

        do {
            // Own profile — full calculation + write-back
            if let viewerID, viewerID == userID {
                async let userTask = userRepository.fetchUser(uid: userID)
                async let libraryTask = watchlistRepository.fetchLibrary(userID: userID)
                async let seriesProgressTask = watchlistRepository.fetchPublicProfileSeriesProgress(userID: userID)
                async let followersTask = userRepository.listFollowers(userID: userID)
                async let followingTask = userRepository.listFollowing(userID: userID)
                // users/{uid} letto una volta sola: attività e review count
                // riusano il doc via `preloadedUser` (le task pesanti sopra
                // sono già partite, quindi nessuna serializzazione aggiunta).
                let fetchedUser = try await userTask
                user = fetchedUser
                async let activityTask = watchlistRepository.fetchProfileActivitySummary(userID: userID, preloadedUser: fetchedUser)
                async let reviewTask = watchlistRepository.fetchReviewCount(userID: userID, preloadedUser: fetchedUser)
                do { activitySummary = try await activityTask } catch { SilentFailure.record(error, context: "UserProfile.own.activity"); activitySummary = .empty }
                do { reviewCount = try await reviewTask } catch { SilentFailure.record(error, context: "UserProfile.own.reviewCount"); reviewCount = 0 }
                do { watchedEntries = sortedLibraryEntries(try await libraryTask) } catch { SilentFailure.record(error, context: "UserProfile.own.library"); watchedEntries = [] }
                do { seriesProgress = try await seriesProgressTask } catch { SilentFailure.record(error, context: "UserProfile.own.seriesProgress"); seriesProgress = [:] }
                do { followers = try await followersTask } catch { SilentFailure.record(error, context: "UserProfile.own.followers"); followers = [] }
                do { following = try await followingTask } catch { SilentFailure.record(error, context: "UserProfile.own.following"); following = [] }
                relationship = nil
                return
            }

            // Other user — library is blocked by security rules, use cached stats
            if let viewerID {
                async let userTask = userRepository.fetchUser(uid: userID)
                async let relationshipTask = userRepository.fetchRelationshipState(myUid: viewerID, otherUid: userID)
                async let activityTask = watchlistRepository.fetchPublicProfileActivitySummary(userID: userID)
                async let libraryTask = watchlistRepository.fetchLibrary(userID: userID)
                async let seriesProgressTask = watchlistRepository.fetchPublicProfileSeriesProgress(userID: userID)
                async let followersTask = userRepository.listFollowers(userID: userID)
                async let followingTask = userRepository.listFollowing(userID: userID)
                let (fetchedUser, fetchedRelationship) = try await (userTask, relationshipTask)
                user = fetchedUser
                relationship = fetchedRelationship
                // Dedup users/{uid}: il review count riusa il doc appena letto.
                async let reviewTask = watchlistRepository.fetchReviewCount(userID: userID, preloadedUser: fetchedUser)
                do { activitySummary = try await activityTask } catch { SilentFailure.record(error, context: "UserProfile.other.activity"); activitySummary = activitySummaryFromCachedStats() }
                do { reviewCount = try await reviewTask } catch { SilentFailure.record(error, context: "UserProfile.other.reviewCount"); reviewCount = 0 }
                do { watchedEntries = sortedLibraryEntries(try await libraryTask) } catch { SilentFailure.record(error, context: "UserProfile.other.library"); watchedEntries = [] }
                do { seriesProgress = try await seriesProgressTask } catch { SilentFailure.record(error, context: "UserProfile.other.seriesProgress"); seriesProgress = [:] }
                do { followers = try await followersTask } catch { SilentFailure.record(error, context: "UserProfile.other.followers"); followers = [] }
                do { following = try await followingTask } catch { SilentFailure.record(error, context: "UserProfile.other.following"); following = [] }
            } else {
                // Not logged in — same as other user
                async let userTask = userRepository.fetchUser(uid: userID)
                async let libraryTask = watchlistRepository.fetchLibrary(userID: userID)
                async let followersTask = userRepository.listFollowers(userID: userID)
                async let followingTask = userRepository.listFollowing(userID: userID)
                let fetchedUser = try await userTask
                user = fetchedUser
                // Dedup users/{uid}: il review count riusa il doc appena letto.
                async let reviewTask = watchlistRepository.fetchReviewCount(userID: userID, preloadedUser: fetchedUser)
                activitySummary = activitySummaryFromCachedStats()
                do { reviewCount = try await reviewTask } catch { SilentFailure.record(error, context: "UserProfile.guest.reviewCount"); reviewCount = 0 }
                do { watchedEntries = sortedLibraryEntries(try await libraryTask) } catch { SilentFailure.record(error, context: "UserProfile.guest.library"); watchedEntries = [] }
                // CF richiede auth: ospite → niente badge avanzamento.
                seriesProgress = [:]
                do { followers = try await followersTask } catch { SilentFailure.record(error, context: "UserProfile.guest.followers"); followers = [] }
                do { following = try await followingTask } catch { SilentFailure.record(error, context: "UserProfile.guest.following"); following = [] }
                relationship = nil
            }
        } catch {
            user = nil
            relationship = nil
            activitySummary = .empty
            reviewCount = 0
            reviews = []
            emotions = []
            posts = []
            watchedEntries = []
            seriesProgress = [:]
            followers = []
            following = []
            errorMessage = UserFacingError.message(for: error)
        }
    }

    /// Carica review + emozioni + post pubblici una sola volta, alla prima
    /// selezione del tab Attività (`ProfileContentTab.reviews`). Letture valide
    /// anche per un viewer diverso dal titolare (ratings/titleEmotions/posts
    /// pubblici sono leggibili da qualunque utente autenticato).
    func loadActivityIfNeeded() async {
        guard !hasLoadedActivity else { return }
        hasLoadedActivity = true
        isLoadingActivity = true
        defer { isLoadingActivity = false }

        async let reviewEntriesTask = watchlistRepository.fetchProfileReviews(userID: userID)
        async let emotionsTask = titleRepository.fetchMyEmotions(userID: userID)
        async let postsTask = watchlistRepository.fetchPublicPostsByAuthor(userID: userID)

        do { reviews = try await reviewEntriesTask } catch { SilentFailure.record(error, context: "UserProfile.reviews"); reviews = [] }
        do { emotions = try await emotionsTask } catch { SilentFailure.record(error, context: "UserProfile.emotions"); emotions = [] }
        do { posts = try await postsTask } catch { SilentFailure.record(error, context: "UserProfile.posts"); posts = [] }
        reviewCount = max(reviewCount, reviews.count)
    }

    /// Build activity summary from the user document's cached stats.
    /// Library reads are blocked by Firestore rules for non-owner/non-friend viewers,
    /// so we rely on the cached stats counters kept fresh server-side by Cloud Functions.
    private func activitySummaryFromCachedStats() -> ProfileActivitySummary {
        guard let user else { return .empty }
        return ProfileActivitySummary(
            ratedTitlesCount: user.stats.ratingsCount,
            watchedTitlesCount: user.stats.watchedCount,
            totalWatchMinutes: user.stats.totalWatchMinutes,
            byCategory: user.stats.byCategory
        )
    }

    func follow() async {
        await performViewerMutation {
            try await userRepository.followUser(myUid: $0, targetUid: userID)
        }
    }

    func unfollow() async {
        await performViewerMutation {
            try await userRepository.unfollowUser(myUid: $0, targetUid: userID)
        }
    }

    func blockUser() async {
        await performViewerMutation(successMessage: String(localized: "Utente bloccato. Le interazioni in chat vengono limitate."), refresh: .full) {
            try await userRepository.blockUser(myUid: $0, targetUid: userID, source: "ios_profile")
        }
    }

    func unblockUser() async {
        await performViewerMutation(successMessage: "Utente sbloccato correttamente.", refresh: .full) {
            try await userRepository.unblockUser(myUid: $0, targetUid: userID)
        }
    }

    /// Apre (o crea) una chat 1:1 con il profilo corrente. Restituisce l'ID del thread
    /// pronto per essere usato come destination `.thread(id:)`. Nessuna chat con sé stessi
    /// e nessun invio se la relazione è bloccata.
    func openDirectMessage() async -> String? {
        guard let viewerID = currentViewerID, viewerID != userID else {
            errorMessage = String(localized: "Accedi per inviare un messaggio.")
            return nil
        }

        if let relationship, relationship.isBlocked {
            errorMessage = String(localized: "Hai bloccato questo utente. Sbloccalo per inviare un messaggio.")
            return nil
        }

        isOpeningChat = true
        errorMessage = nil
        defer { isOpeningChat = false }

        do {
            let thread = try await threadsRepository.ensureDirectThread(
                uidA: viewerID,
                uidB: userID,
                createdBy: viewerID
            )
            return thread.id
        } catch {
            errorMessage = UserFacingError.message(for: error)
            return nil
        }
    }

    func reportUser() async {
        await performViewerMutation(successMessage: "Profilo segnalato al team di moderazione.", refresh: .full) {
            try await userRepository.reportUser(fromUid: $0, targetUid: userID)
        }
    }

    /// Cosa ricaricare dopo una mutazione della relazione viewer→profilo.
    /// `.relationship` basta per follow/unfollow: cambia solo lo stato relazione
    /// + il contatore follower, non serve
    /// riscaricare libreria/summary/review. `.full` resta per block/unblock/report
    /// perché il blocco può cambiare i contenuti visibili.
    private enum PostMutationRefresh {
        case relationship
        case full
    }

    private func performViewerMutation(
        successMessage: String? = nil,
        refresh: PostMutationRefresh = .relationship,
        _ mutation: (String) async throws -> Void
    ) async {
        guard let viewerID = currentViewerID, viewerID != userID else {
            errorMessage = String(localized: "Accedi per gestire questo profilo.")
            return
        }

        isUpdating = true
        errorMessage = nil
        self.successMessage = nil
        defer { isUpdating = false }

        do {
            try await mutation(viewerID)
            switch refresh {
            case .relationship:
                async let relationshipTask = userRepository.fetchRelationshipState(myUid: viewerID, otherUid: userID)
                async let followersTask = userRepository.listFollowers(userID: userID)
                relationship = try await relationshipTask
                do { followers = try await followersTask } catch { SilentFailure.record(error, context: "UserProfile.followersRefresh") }
            case .full:
                await load(viewerID: viewerID)
            }
            self.successMessage = successMessage
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
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

struct UserProfileDetailView: View {
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore
    let userID: String
    private let disablesAutomaticLoading: Bool

    @State private var viewModel: UserProfileDetailViewModel
    @State private var selectedTab: ProfileContentTab = .watched
    @State private var activeConnectionsTab: ProfileConnectionsTab?
    /// Filtro tipo condiviso strip-contatori ↔ tab "Visti" (vedi ProfileView).
    @State private var watchedCategoryFilter: Set<ContentCategory> = []

    private let lightTextPrimary = Color(hex: "#131826")
    private let lightTextSecondary = Color(hex: "#5F6777")

    init(container: AppContainer, session: SessionStore, shell: AppShellStore, userID: String) {
        self.container = container
        self.session = session
        self.shell = shell
        self.userID = userID
        disablesAutomaticLoading = false
        _viewModel = State(initialValue: UserProfileDetailViewModel(
            userID: userID,
            userRepository: container.userRepository,
            watchlistRepository: container.watchlistRepository,
            threadsRepository: container.threadsRepository,
            titleRepository: container.titleRepository
        ))
    }

#if DEBUG
    init(
        container: AppContainer,
        session: SessionStore,
        shell: AppShellStore,
        userID: String,
        previewViewModel: UserProfileDetailViewModel
    ) {
        self.container = container
        self.session = session
        self.shell = shell
        self.userID = userID
        disablesAutomaticLoading = true
        _viewModel = State(initialValue: previewViewModel)
    }
#endif

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let successMessage = viewModel.successMessage {
                    successBanner(successMessage)
                }

                if let user = viewModel.user {
                    publicProfileHeroCard(user: user)

                    if user.isGuidedProfile {
                        guidedProfileDisclosureCard(user: user)
                    }

                    ProfileActivitySummarySection(
                        activitySummary: viewModel.activitySummary,
                        reviewCount: effectiveReviewCount(for: user),
                        isLoading: viewModel.isLoading,
                        user: viewModel.isOwnProfile ? user : nil,
                        showsReviewCount: false,
                        showsCaption: false,
                        categoryCounts: profileWatchedCategoryCounts(viewModel.watchedEntries),
                        categoryFilterSelection: $watchedCategoryFilter,
                        onCategoryFilterSelected: { _ in
                            if selectedTab != .watched {
                                withAnimation(.easeInOut(duration: 0.2)) { selectedTab = .watched }
                            }
                        }
                    )

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
                } else if viewModel.isLoading {
                    ProgressView()
                        .tint(TwoWatchTheme.textPrimary)
                        .frame(maxWidth: .infinity, minHeight: 260)
                } else {
                    EmptyStateView(
                        title: "Profilo non disponibile", // i18n-ok: LocalizedStringKey
                        message: LocalizedStringKey(viewModel.errorMessage ?? String(localized: "Non siamo riusciti a caricare questo profilo.")),
                        systemImage: "person.crop.circle.badge.exclamationmark"
                    )
                }
            }
            .padding(.horizontal, 14)
            .padding(.top, 16)
            .padding(.bottom, 20)
        }
        .background(TwoWatchBackground())
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: session.firebaseUser?.uid) {
            guard !disablesAutomaticLoading else { return }
            await viewModel.load(viewerID: session.firebaseUser?.uid)
        }
        .refreshable {
            guard !disablesAutomaticLoading else { return }
            await viewModel.load(viewerID: session.firebaseUser?.uid)
        }
        .onChange(of: selectedTab) { _, newTab in
            // Anche il tab Visti serve le emozioni, per il filtro "Emozione".
            // `loadActivityIfNeeded` è idempotente, quindi la seconda chiamata
            // non costa nulla.
            guard !disablesAutomaticLoading, newTab == .reviews || newTab == .watched else { return }
            Task { await viewModel.loadActivityIfNeeded() }
        }
        .alert("Errore", isPresented: Binding(
            get: { viewModel.errorMessage != nil },
            set: { _ in viewModel.errorMessage = nil }
        )) {
            Button("Chiudi", role: .cancel) {}
        } message: {
            Text(viewModel.errorMessage ?? "")
        }
        .sheet(item: $activeConnectionsTab) { tab in
            NavigationStack {
                ProfileConnectionsSheet(
                    container: container,
                    session: session,
                    shell: shell,
                    title: tab.title,
                    systemImage: tab.systemImage,
                    users: users(for: tab)
                )
            }
            .presentationDetents([.large])
            .presentationDragIndicator(.visible)
        }
    }

    private func successBanner(_ message: String) -> some View {
        GlassCard {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "checkmark.circle.fill")
                    .font(.title3.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.success)

                Text(message)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                    .frame(maxWidth: .infinity, alignment: .leading)

                Button {
                    viewModel.successMessage = nil
                } label: {
                    Image(systemName: "xmark")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(lightTextSecondary)
                        .frame(width: 24, height: 24)
                        .background(TwoWatchTheme.panelStrong, in: Circle())
                }
                .buttonStyle(.plain)
                // Area tocco ≥44pt; chip visivo resta 24pt
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(Rectangle())
                .accessibilityLabel("Chiudi")
            }
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
                isOwnProfile: viewModel.isOwnProfile,
                onLibraryChanged: {
                    Task { await viewModel.load(viewerID: session.firebaseUser?.uid) }
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

    /// Titoli votati. `stats.reviewsCount` non lo aggiorna nessuno (nasce 0 e
    /// resta 0): tenerlo nel max non aggiungeva niente e suggeriva una fonte
    /// che non esiste. Vedi WatchlistRepository.fetchReviewCount.
    private func effectiveReviewCount(for user: AppUser) -> Int {
        max(viewModel.reviewCount, user.stats.ratingsCount)
    }

    private func publicProfileHeroCard(user: AppUser) -> some View {
        // Nome + avatar in cima, poi le metriche, poi UNA riga di azioni (segui/seguito +
        // messaggio + menu + condividi) sotto le metriche. Il nome ha così sempre l'intera
        // larghezza della card (maxWidth .infinity) e non tronca mai, indipendentemente dal
        // badge verificato o da handle lunghi.
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .center, spacing: 12) {
                avatar(for: user)
                    .frame(width: 64, height: 64)
                    .clipShape(Circle())
                    .overlay(
                        Circle()
                            .stroke(Color.white.opacity(0.88), lineWidth: 2.5)
                    )
                    .avatarZoomable(
                        url: user.avatarURL ?? user.photoURL,
                        initials: String(user.displayName.prefix(1)).uppercased()
                    )

                VStack(alignment: .leading, spacing: 4) {
                    HStack(alignment: .center, spacing: 6) {
                        Text(user.displayName)
                            .font(.title3.weight(.black))
                            .foregroundStyle(lightTextPrimary)
                            .lineLimit(1)
                            .truncationMode(.tail)

                        if user.verified {
                            Image(systemName: "checkmark.seal.fill")
                                .font(.caption.weight(.bold))
                                .foregroundStyle(TwoWatchTheme.brandPrimary)
                                .accessibilityLabel("Profilo verificato")
                        }
                    }

                    Text("@\(user.displayNameLower)")
                        .font(.caption)
                        .foregroundStyle(lightTextSecondary)
                        .lineLimit(1)
                        .truncationMode(.tail)

                    if user.isGuidedProfile {
                        guidedProfileChip
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            publicProfileMetrics(user: user)

            publicProfileActionRow(user: user)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(Color(hex: "#FCFBF6"), in: RoundedRectangle(cornerRadius: 26, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 26, style: .continuous)
                .stroke(Color.black.opacity(0.06), lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.12), radius: 16, y: 8)
    }

    /// Riga azioni sotto le metriche: segui/seguito a larghezza flessibile (riempie lo
    /// spazio residuo) seguito da messaggio, menu e condividi a dimensione fissa. Sul
    /// profilo proprio `publicRelationshipActions` è EmptyView, quindi la riga mostra solo
    /// Condividi (Messaggio/menu restano nascosti da `profileHeroActions`).
    private func publicProfileActionRow(user: AppUser) -> some View {
        HStack(alignment: .top, spacing: 8) {
            publicRelationshipActions

            profileHeroActions(user: user)
        }
    }

    /// Azioni sotto le metriche del profilo altrui: invia messaggio, menu, condividi.
    /// Tasti a dimensione fissa (area tocco ≥44pt) accanto al tasto segui/seguito
    /// (che riempie lo spazio residuo in `publicProfileActionRow`).
    @ViewBuilder
    private func profileHeroActions(user: AppUser) -> some View {
        HStack(spacing: 6) {
            if !viewModel.isOwnProfile, session.firebaseUser?.uid != nil {
                Button {
                    Task {
                        guard let threadID = await viewModel.openDirectMessage() else { return }
                        shell.present(
                            destination: .thread(id: threadID),
                            currentUserID: session.firebaseUser?.uid
                        )
                    }
                } label: {
                    ZStack {
                        Image(systemName: "paperplane.fill")
                            .font(.footnote.weight(.bold))
                            .foregroundStyle(.black)
                            .opacity(viewModel.isOpeningChat ? 0 : 1)
                        if viewModel.isOpeningChat {
                            ProgressView()
                                .controlSize(.mini)
                                .tint(.black)
                        }
                    }
                    .frame(width: 32, height: 32)
                    .background(Color.black.opacity(0.06), in: Circle())
                }
                .buttonStyle(.plain)
                .disabled(viewModel.isOpeningChat || (viewModel.relationship?.isBlocked ?? false))
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(Rectangle())
                .accessibilityLabel("Invia messaggio")

                if let relationship = viewModel.relationship {
                    Menu {
                        profileActionMenuContent(relationship)
                    } label: {
                        Image(systemName: "ellipsis")
                            .font(.footnote.weight(.bold))
                            .foregroundStyle(.black)
                            .frame(width: 32, height: 32)
                            .background(Color.black.opacity(0.06), in: Circle())
                    }
                    .frame(minWidth: 44, minHeight: 44)
                    .contentShape(Rectangle())
                    .accessibilityLabel("Azioni profilo")
                }
            }

            if let shareURL = profileShareURL(forUserID: user.id) {
                ShareLink(item: shareURL) {
                    Image(systemName: "square.and.arrow.up")
                        .font(.footnote.weight(.bold))
                        .foregroundStyle(.black)
                        .frame(width: 32, height: 32)
                        .background(Color.black.opacity(0.06), in: Circle())
                }
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(Rectangle())
                .accessibilityLabel("Condividi profilo")
            }
        }
    }

    /// Testo di disclosure di default per i profili guidati quando il campo `bio` è vuoto.
    private static let guidedProfileDisclosureFallback = String(localized: "Profilo guidato da Somto per testare e migliorare l'esperienza nell'app. I contenuti possono essere generati con supporto AI e supervisionati prima della pubblicazione.")

    private var guidedProfileChip: some View {
        HStack(spacing: 4) {
            Image(systemName: "sparkles")
                .font(.system(size: 9, weight: .bold))
            Text("Profilo guidato")
                .font(.system(size: 11, weight: .semibold))
        }
        .foregroundStyle(TwoWatchTheme.brandPrimary)
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(
            Capsule(style: .continuous)
                .fill(TwoWatchTheme.brandPrimary.opacity(0.12))
        )
        .accessibilityLabel("Profilo guidato")
    }

    private func guidedProfileDisclosureCard(user: AppUser) -> some View {
        let text = user.bio.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? Self.guidedProfileDisclosureFallback
            : user.bio

        return HStack(alignment: .top, spacing: 12) {
            Image(systemName: "info.circle.fill")
                .font(.subheadline.weight(.bold))
                .foregroundStyle(TwoWatchTheme.brandPrimary)

            VStack(alignment: .leading, spacing: 4) {
                Text("Profilo guidato")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(lightTextPrimary)
                Text(text)
                    .font(.footnote)
                    .foregroundStyle(lightTextSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: 0)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(hex: "#FCFBF6"), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .stroke(TwoWatchTheme.brandPrimary.opacity(0.18), lineWidth: 1)
        )
    }

    private func publicProfileMetrics(user: AppUser) -> some View {
        return HStack(spacing: 10) {
            metricLabel(title: "Visti", value: viewModel.activitySummary.watchedTitlesCount)
            metricSeparator
            metricLabel(title: "Voti", value: effectiveReviewCount(for: user))
            metricSeparator
            metricButton(title: "Follower", value: viewModel.followers.count) {
                activeConnectionsTab = .followers
            }
            metricSeparator
            metricButton(title: "Seguiti", value: viewModel.following.count) {
                activeConnectionsTab = .following
            }
        }
    }

    @ViewBuilder
    private var publicRelationshipActions: some View {
        if viewModel.isOwnProfile {
            EmptyView()
        } else if session.firebaseUser?.uid == nil {
            Button {
                shell.presentAuth()
            } label: {
                Text("Accedi per seguire")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 11)
                    .background(TwoWatchTheme.brandPrimary, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            }
            .buttonStyle(.plain)
        } else if let relationship = viewModel.relationship {
            // VStack esplicito: `publicRelationshipActions` è annegato nella riga
            // `publicProfileActionRow` (un HStack) insieme alle icone messaggio/menu/
            // condividi. Senza questo wrapper l'eventuale testo "bloccato" sotto si
            // affiancherebbe in orizzontale invece di restare sotto al tasto.
            VStack(alignment: .leading, spacing: 6) {
                Button {
                    Task {
                        if relationship.isFollowing {
                            await viewModel.unfollow()
                        } else {
                            await viewModel.follow()
                        }
                    }
                } label: {
                    HStack(spacing: 8) {
                        if viewModel.isUpdating {
                            ProgressView()
                                .controlSize(.small)
                                .tint(followButtonForeground(for: relationship))
                        }

                        Text(followButtonTitle(for: relationship))
                            .font(.subheadline.weight(.bold))
                    }
                    .foregroundStyle(followButtonForeground(for: relationship))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 11)
                    .background(followButtonBackground(for: relationship), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 18, style: .continuous)
                            .stroke(followButtonBorder(for: relationship), lineWidth: 1)
                    )
                }
                .buttonStyle(.plain)
                .disabled(viewModel.isUpdating || relationship.isBlocked)

                if relationship.isBlocked {
                    Text("Hai bloccato questo utente. Puoi sbloccarlo dal menu.")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(lightTextSecondary)
                }
            }
        }
    }

    @ViewBuilder
    private func profileActionMenuContent(_ relationship: UserRelationshipState) -> some View {
        if relationship.isBlocked {
            Button {
                Task { await viewModel.unblockUser() }
            } label: {
                Label("Sblocca utente", systemImage: "hand.raised.slash")
            }
        } else {
            Button(role: .destructive) {
                Task { await viewModel.reportUser() }
            } label: {
                Label("Segnala utente", systemImage: "exclamationmark.triangle")
            }

            Button(role: .destructive) {
                Task { await viewModel.blockUser() }
            } label: {
                Label("Blocca utente", systemImage: "hand.raised")
            }
        }
    }

    private func avatar(for user: AppUser) -> some View {
        CachedAsyncImage(url: user.avatarURL) { phase in
            switch phase {
            case let .success(image):
                image.resizable().scaledToFill()
            default:
                ZStack {
                    TwoWatchTheme.brandGradient
                    Text(String(user.displayName.prefix(1)).uppercased())
                        .font(.title.bold())
                        .foregroundStyle(.white)
                }
            }
        }
    }

    private func followButtonTitle(for relationship: UserRelationshipState) -> String {
        if relationship.isBlocked {
            return "Utente bloccato"
        }
        return relationship.isFollowing ? "Seguito" : "Segui"
    }

    private func followButtonForeground(for relationship: UserRelationshipState) -> Color {
        relationship.isFollowing ? lightTextPrimary : .white
    }

    private func followButtonBackground(for relationship: UserRelationshipState) -> Color {
        relationship.isFollowing ? Color.white.opacity(0.82) : TwoWatchTheme.brandPrimary
    }

    private func followButtonBorder(for relationship: UserRelationshipState) -> Color {
        relationship.isFollowing ? Color.black.opacity(0.08) : TwoWatchTheme.brandPrimary
    }

    private func formattedCount(_ value: Int) -> String {
        if value < 1_000 {
            return "\(value)"
        }

        let number = Double(value)
        let formatted: String
        if number >= 10_000 {
            formatted = String(format: "%.0fk", number / 1_000)
        } else {
            formatted = String(format: "%.1fk", number / 1_000)
        }
        return formatted.replacingOccurrences(of: ".0", with: "")
    }

    private func users(for tab: ProfileConnectionsTab) -> [AppUser] {
        switch tab {
        case .followers:
            return viewModel.followers
        case .following:
            return viewModel.following
        }
    }

    private func metricLabel(title: String, value: Int) -> some View {
        VStack(spacing: 4) {
            Text(formattedCount(value))
                .font(.subheadline.weight(.black))
                .foregroundStyle(lightTextPrimary)

            Text(title)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(lightTextSecondary)
        }
        .frame(maxWidth: .infinity)
    }

    private func metricButton(title: String, value: Int, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            metricLabel(title: title, value: value)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(title), \(value)")
        .accessibilityHint(String(localized: "Apre la lista completa"))
    }

    private var metricSeparator: some View {
        Text("|")
            .font(.caption.weight(.bold))
            .foregroundStyle(Color.black.opacity(0.18))
    }
}

#if DEBUG
#Preview("Profilo pubblico") {
    NavigationStack {
        UserProfileDetailView(
            container: TwoWatchPreview.container,
            session: TwoWatchPreview.session(),
            shell: TwoWatchPreview.shell(),
            userID: TwoWatchPreview.friendUser.id,
            previewViewModel: TwoWatchPreview.userProfileDetailViewModel()
        )
    }
}
#endif

private struct WrapChipsView: View {
    let items: [String]

    var body: some View {
        let columns = [GridItem(.adaptive(minimum: 96), spacing: 8, alignment: .leading)]

        LazyVGrid(columns: columns, alignment: .leading, spacing: 8) {
            ForEach(items, id: \.self) { item in
                Text(item)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(TwoWatchTheme.panelStrong, in: Capsule())
            }
        }
    }
}
