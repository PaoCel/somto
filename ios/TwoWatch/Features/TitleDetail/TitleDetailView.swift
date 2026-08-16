import Observation
import PhotosUI
import SafariServices
import SwiftUI
import UIKit
import WebKit

private let titleDetailTourVersion = 1

enum TitleDetailTab: String, CaseIterable, Identifiable {
    case overview = "Panoramica"
    case episodes = "Episodi"
    case updates = "Aggiornamenti"
    case community = "Community"

    var id: String { rawValue }

    var systemName: String {
        switch self {
        case .overview:
            return "text.rectangle.page.fill"
        case .episodes:
            return "list.bullet.rectangle.portrait.fill"
        case .updates:
            return "clock.badge"
        case .community:
            return "bubble.left.and.bubble.right.fill"
        }
    }
}

struct TitleDetailView: View {
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore
    let titleID: String
    private let disablesAutomaticLoading: Bool
    private let focusedUpdateEventID: String?

    @State private var viewModel: TitleDetailViewModel
    @State private var isRatingSheetPresented = false
    /// Foglio cast: `nil` chiuso, altrimenti il modo (sfoglia / vota).
    @State private var castSheetMode: TitleCastSheet.Mode?
    @State private var ratingComposerInitialRating: Double?
    @State private var ratingComposerLevel: String = "title"
    @State private var ratingComposerSeason: Int?
    @State private var ratingComposerEpisode: Int?
    @State private var pendingQuickSeasonNumber: Int?
    @State private var isDescriptionExpanded = false
    @State private var expandedSeasonNumber: Int?
    @State private var isRecommendationSheetPresented = false
    @State private var isGroupSheetPresented = false
    @State private var isFriendsVotesSheetPresented = false
    @State private var isWatchActionsSheetPresented = false
    @State private var isEditorialSheetPresented = false
    @State private var isSeenWatchlistRoutingPresented = false
    @State private var isQuickRatingReviewPromptPresented = false
    @State private var pendingQuickRatingValue: Double?
    @State private var destinationThread: AppThread?
    @State private var scrollOffset: CGFloat = 0
    @State private var selectedTab: TitleDetailTab = .overview
    @State private var isTitleDetailTourPresented = false
    @AppStorage(SomtoDefaultsKey.titleDetailTourVersion) private var storedTitleDetailTourVersion = 0

    init(container: AppContainer, session: SessionStore, shell: AppShellStore, titleID: String, initialFocus: String? = nil) {
        self.container = container
        self.session = session
        self.shell = shell
        self.titleID = titleID
        disablesAutomaticLoading = false
        let focusParts = initialFocus?.split(separator: "|", maxSplits: 1).map(String.init) ?? []
        focusedUpdateEventID = focusParts.first == "updates" && focusParts.count > 1 ? focusParts[1] : nil
        switch focusParts.first {
        case "updates": _selectedTab = State(initialValue: .updates)
        case "episodes": _selectedTab = State(initialValue: .episodes)
        case "community", "rating": _selectedTab = State(initialValue: .community)
        default: _selectedTab = State(initialValue: .overview)
        }
        _viewModel = State(initialValue: TitleDetailViewModel(
            titleID: titleID,
            titleRepository: container.titleRepository,
            watchlistRepository: container.watchlistRepository,
            userRepository: container.userRepository,
            analytics: container.analytics
        ))
    }

#if DEBUG
    init(container: AppContainer, session: SessionStore, shell: AppShellStore, titleID: String, initialFocus: String? = nil, previewViewModel: TitleDetailViewModel) {
        self.container = container
        self.session = session
        self.shell = shell
        self.titleID = titleID
        disablesAutomaticLoading = true
        focusedUpdateEventID = nil
        previewViewModel.hasCompletedInitialPresentationLoad = previewViewModel.title != nil
        _viewModel = State(initialValue: previewViewModel)
    }
#endif

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .top) {
                TwoWatchBackground()
                    .ignoresSafeArea()

                content(topSafeArea: geometry.safeAreaInsets.top, availableWidth: geometry.size.width)

                Rectangle()
                    .fill(.ultraThinMaterial)
                    .frame(height: geometry.safeAreaInsets.top + 52)
                    .overlay(alignment: .bottom) {
                        Divider()
                            .overlay(TwoWatchTheme.border)
                    }
                    .opacity(navigationBarOpacity)
                    .ignoresSafeArea(edges: .top)
                    .allowsHitTesting(false)
            }
            .coordinateSpace(name: TitleDetailScrollSpace.name)
            .navigationTitle("")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbarBackground(.hidden, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Text(viewModel.title?.name ?? "")
                        .font(.headline.weight(.semibold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                        .lineLimit(1)
                        .opacity(navigationBarOpacity)
                }

                ToolbarItem(placement: .topBarTrailing) {
                    if let shareURL = viewModel.title?.shareURL {
                        ShareLink(item: shareURL) {
                            Image(systemName: "square.and.arrow.up")
                                .font(.headline.weight(.semibold))
                                .foregroundStyle(TwoWatchTheme.textPrimary)
                        }
                        .opacity(viewModel.title == nil ? 0 : 1)
                    }
                }
            }
            .task {
                guard !disablesAutomaticLoading else { return }
                viewModel.logTitleOpenedIfNeeded()
                await reload()
                if storedTitleDetailTourVersion < titleDetailTourVersion {
                    isTitleDetailTourPresented = true
                }
            }
            .onChange(of: session.firebaseUser?.uid) { _, _ in
                guard !disablesAutomaticLoading else { return }
                Task { await reload() }
            }
            .onPreferenceChange(TitleDetailScrollOffsetKey.self) { value in
                scrollOffset = value
            }
            .sheet(item: $castSheetMode) { mode in
                if let title = viewModel.title {
                    TitleCastSheet(
                        container: container,
                        session: session,
                        shell: shell,
                        title: title,
                        mode: mode,
                        // Anteprima immediata dai credits gia' in memoria: il
                        // foglio non deve mai aprirsi vuoto mentre TMDB risponde.
                        initialCandidates: viewModel.castCredits.compactMap { person in
                            guard let personID = person.personID else { return nil }
                            return CharacterCandidate(
                                personId: personID,
                                name: person.name,
                                character: person.character,
                                profileURL: person.avatarURL,
                                order: 999,
                                isGuest: false
                            )
                        },
                        communityBucket: viewModel.characterBucket
                    )
                }
            }
            .sheet(isPresented: $isRatingSheetPresented) {
                if let title = viewModel.title, let uid = session.firebaseUser?.uid {
                    RatingPostComposerSheet(
                        container: container,
                        currentUserID: uid,
                        currentUserName: currentUserDisplayName,
                        title: title,
                        level: ratingComposerLevel,
                        season: ratingComposerSeason,
                        episode: ratingComposerEpisode,
                        existingRating: viewModel.rating(
                            level: ratingComposerLevel,
                            season: ratingComposerSeason,
                            episode: ratingComposerEpisode
                        ),
                        hasAcceptedCommunitySafety: session.appUser?.hasAcceptedCommunitySafetyTerms == true,
                        initialRating: ratingComposerInitialRating
                    ) {
                        Task { await reload() }
                    }
                } else {
                    EmptyStateView(
                        title: "Accedi per votare",
                        message: "Serve una sessione attiva per salvare voto, review e immagini.",
                        systemImage: "person.crop.circle.badge.plus"
                    )
                    .padding(20)
                }
            }
            .presentationDetents([.large])
            .sheet(isPresented: $isEditorialSheetPresented) {
                if let title = viewModel.title,
                   let currentUser = session.appUser,
                   currentUser.canEditTitleEditorialContent {
                    TitleEditorialEditorSheet(
                        title: title,
                        isOverviewMissing: !TitleDetailFormatter.hasOverview(title),
                        isTrailerMissing: viewModel.trailerURL == nil
                    ) { overview, trailerInput in
                        try await viewModel.saveEditorialContent(
                            currentUser: currentUser,
                            overview: overview,
                            trailerInput: trailerInput
                        )
                    }
                } else {
                    EmptyStateView(
                        title: "Modifica non disponibile",
                        message: "Questo account non può aggiornare sinossi o trailer.",
                        systemImage: "lock.fill"
                    )
                    .padding(20)
                }
            }
            .sheet(isPresented: $isRecommendationSheetPresented) {
                if let title = viewModel.title, let userID = session.firebaseUser?.uid {
                    RecommendationComposerSheet(
                        container: container,
                        currentUserID: userID,
                        currentUserName: currentUserDisplayName,
                        title: title,
                        hasAcceptedCommunitySafety: session.appUser?.hasAcceptedCommunitySafetyTerms == true
                    )
                } else {
                    EmptyStateView(
                        title: "Accedi per suggerire",
                        message: "Serve una sessione attiva per inviare un titolo a un amico.",
                        systemImage: "person.crop.circle.badge.plus"
                    )
                    .padding(20)
                }
            }
            .sheet(isPresented: $isGroupSheetPresented) {
                if let title = viewModel.title, let userID = session.firebaseUser?.uid {
                    GroupDiscussionSheet(
                        container: container,
                        currentUserID: userID,
                        currentUserName: currentUserDisplayName,
                        title: title,
                        hasAcceptedCommunitySafety: session.appUser?.hasAcceptedCommunitySafetyTerms == true
                    ) { thread in
                        destinationThread = thread
                    }
                } else {
                    EmptyStateView(
                        title: "Accedi per aprire un gruppo",
                        message: "Serve una sessione attiva per condividere un titolo in chat.",
                        systemImage: "bubble.left.and.bubble.right.fill"
                    )
                    .padding(20)
                }
            }
            .sheet(isPresented: $isFriendsVotesSheetPresented) {
                FriendsTitleVotesSheet(entries: viewModel.friendVoteEntries)
            }
            .sheet(isPresented: $isTitleDetailTourPresented, onDismiss: completeTitleDetailTour) {
                TitleDetailWhatsNewSheet(
                    onSkip: {
                        completeTitleDetailTour()
                        isTitleDetailTourPresented = false
                    },
                    onFinish: {
                        completeTitleDetailTour()
                        isTitleDetailTourPresented = false
                    }
                )
                .presentationDetents([.height(360)])
                .presentationDragIndicator(.visible)
                .presentationBackground(TwoWatchTheme.panelStrong)
            }
            .sheet(isPresented: $isWatchActionsSheetPresented) {
                if let title = viewModel.title {
                    TitleWatchActionsSheet(
                        title: title,
                        session: session,
                        viewModel: viewModel,
                        onRequireAuth: { shell.presentAuth() },
                        onMarkSeriesEpisode: { uid in
                            let previousCount = viewModel.personalState?.seriesProgress?.episodesWatchedCount ?? 0
                            Task { @MainActor in
                                await viewModel.markSeriesEpisodeWatched(userID: uid)
                                try? await Task.sleep(nanoseconds: 220_000_000)
                                guard let updatedTitle = viewModel.title else { return }
                                let progress = viewModel.personalState?.seriesProgress
                                let episodeRating: Double?
                                if let season = progress?.lastWatchedSeasonNumber,
                                   let episode = progress?.lastWatchedEpisodeNumber {
                                    episodeRating = viewModel.rating(
                                        level: "episode",
                                        season: season,
                                        episode: episode
                                    )?.rating
                                } else {
                                    episodeRating = nil
                                }
                                container.episodeSeenCoordinator.presentAfterAtomicAdvance(
                                    title: updatedTitle,
                                    previousEpisodeCount: previousCount,
                                    updatedProgress: progress,
                                    completesSeries: viewModel.personalState?.isCompleted == true,
                                    hasTitleRating: viewModel.currentUserTitleRating != nil
                                        || viewModel.personalState?.hasTitleRating == true,
                                    source: "title_watch_actions",
                                    existingEpisodeRating: episodeRating
                                )
                            }
                        },
                        onOpenRatingComposer: {
                            isWatchActionsSheetPresented = false
                            openRatingComposer()
                        }
                    )
                }
            }
            .confirmationDialog(
                "Titolo già visto",
                isPresented: $isSeenWatchlistRoutingPresented,
                titleVisibility: .visible
            ) {
                Button("Aggiungi a Rewatch") {
                    guard let uid = session.firebaseUser?.uid else { return }
                    Task { await viewModel.setRewatchIntent(userID: uid, isIncluded: true) }
                }

                Button("Aggiungi a una lista") {
                    isWatchActionsSheetPresented = true
                }

                Button("Annulla", role: .cancel) {}
            } message: {
                Text("I titoli già visti non entrano in Da vedere. Puoi salvarli in Rewatch o aggiungerli a una lista.")
            }
            .confirmationDialog(
                pendingQuickSeasonNumber == nil
                    ? "Aggiungere anche una recensione?"
                    : "Recensione per la stagione \(pendingQuickSeasonNumber ?? 0)?",
                isPresented: $isQuickRatingReviewPromptPresented,
                titleVisibility: .visible
            ) {
                Button("Aggiungi recensione") {
                    let rating = pendingQuickRatingValue ?? ratingComposerInitialRating
                    let season = pendingQuickSeasonNumber
                    pendingQuickRatingValue = nil
                    pendingQuickSeasonNumber = nil
                    if let season {
                        presentRatingComposer(
                            initialRating: rating,
                            level: "season",
                            season: season
                        )
                    } else {
                        presentRatingComposer(initialRating: rating)
                    }
                }

                Button("Non ora") {
                    pendingQuickRatingValue = nil
                    pendingQuickSeasonNumber = nil
                }

                Button("Annulla", role: .cancel) {
                    pendingQuickRatingValue = nil
                    pendingQuickSeasonNumber = nil
                }
            } message: {
                Text(pendingQuickSeasonNumber == nil
                    ? "Il voto è stato salvato. Se vuoi, puoi aggiungere subito una recensione."
                    : "Voto stagione salvato. Vuoi aggiungere una recensione su questa stagione?")
            }
            .navigationDestination(item: $destinationThread) { thread in
                ThreadDetailView(
                    container: container,
                    session: session,
                    shell: shell,
                    threadID: thread.id
                )
            }
            .alert("Errore", isPresented: inlineErrorBinding) {
                Button("Chiudi", role: .cancel) {}
            } message: {
                Text(viewModel.errorMessage ?? "")
            }
        }
    }

    private var currentUserDisplayName: String {
        session.appUser?.displayName ?? session.firebaseUser?.displayName ?? "User"
    }

    private func completeTitleDetailTour() {
        storedTitleDetailTourVersion = titleDetailTourVersion
    }

    private var navigationBarOpacity: Double {
        let progress = (-scrollOffset - 36) / 120
        return min(max(progress, 0), 1)
    }

    private var inlineErrorBinding: Binding<Bool> {
        Binding(
            get: { viewModel.title != nil && viewModel.errorMessage != nil },
            set: { newValue in
                if !newValue {
                    viewModel.errorMessage = nil
                }
            }
        )
    }

    @ViewBuilder
    private func content(topSafeArea: CGFloat, availableWidth: CGFloat) -> some View {
        if !viewModel.hasCompletedInitialPresentationLoad, viewModel.errorMessage == nil {
            ScrollView(showsIndicators: false) {
                TitleLoadingSkeletonView(topSafeArea: topSafeArea)
            }
        } else if let title = viewModel.title {
            ScrollViewReader { proxy in
                ScrollView(showsIndicators: false) {
                    VStack(spacing: 0) {
                        TitleDetailScrollOffsetReader()

                        TitleDetailScreen(
                            title: title,
                            viewModel: viewModel,
                            container: container,
                            session: session,
                            shell: shell,
                            topSafeArea: topSafeArea,
                            availableWidth: availableWidth,
                            selectedTab: selectedTab,
                            isDescriptionExpanded: isDescriptionExpanded,
                            expandedSeasonNumber: expandedSeasonNumber,
                            actions: TitleDetailActions(
                                onSelectTab: { selectedTab = $0 },
                                onToggleDescription: {
                                    withAnimation(.easeInOut(duration: 0.22)) {
                                        isDescriptionExpanded.toggle()
                                    }
                                },
                                onToggleWatchlist: toggleWatchlist,
                                onOpenWatchActions: openWatchActions,
                                onShowAllCast: { castSheetMode = .browse },
                                onVoteCharacters: { castSheetMode = .vote },
                                onOpenEditorialEditor: openEditorialEditor,
                                onOpenRatingComposer: openRatingComposer,
                                onQuickRateTitle: quickRateTitle,
                                onQuickRateSeason: quickRateSeason,
                                onQuickRateEpisode: quickRateEpisode,
                                onToggleSeason: toggleSeason,
                                onSuggestToFriend: openRecommendation,
                                onOpenGroupDiscussion: openGroupDiscussion,
                                onOpenFriendsVotes: { isFriendsVotesSheetPresented = true },
                                onOpenSeasonRatingComposer: presentSeasonRatingComposer,
                                onMigrateTitleRatingToSeason: migrateTitleRatingToSeason
                            )
                        )
                    }
                    .padding(.bottom, 36)
                }
                .onChange(of: viewModel.updates.events.map(\.id)) { _, eventIDs in
                    guard let focusedUpdateEventID, eventIDs.contains(focusedUpdateEventID) else { return }
                    withAnimation(.easeInOut(duration: 0.25)) {
                        proxy.scrollTo("title-update-\(focusedUpdateEventID)", anchor: .center)
                    }
                }
            }
            .refreshable {
                await reload()
            }
        } else {
            ScrollView(showsIndicators: false) {
                TitleErrorStateView(
                    message: viewModel.errorMessage ?? "La scheda non è disponibile in questo momento.",
                    retry: {
                        Task { await reload() }
                    }
                )
                .padding(.horizontal, 20)
                .padding(.top, topSafeArea + 24)
                .padding(.bottom, 40)
            }
            .refreshable {
                await reload()
            }
        }
    }

    private func reload() async {
        await viewModel.load(currentUserID: session.firebaseUser?.uid)
    }

    private func openRatingComposer() {
        guard session.firebaseUser?.uid != nil else {
            shell.presentAuth()
            return
        }
        presentRatingComposer(initialRating: viewModel.currentUserTitleRatingValue)
    }

    private func presentRatingComposer(
        initialRating: Double?,
        level: String = "title",
        season: Int? = nil,
        episode: Int? = nil
    ) {
        ratingComposerInitialRating = initialRating
        ratingComposerLevel = level
        ratingComposerSeason = season
        ratingComposerEpisode = episode
        isRatingSheetPresented = true
    }

    private func presentSeasonRatingComposer(seasonNumber: Int) {
        guard session.firebaseUser?.uid != nil else {
            shell.presentAuth()
            return
        }
        let existing = viewModel.rating(level: "season", season: seasonNumber)?.rating
        presentRatingComposer(
            initialRating: existing ?? viewModel.currentUserTitleRatingValue,
            level: "season",
            season: seasonNumber
        )
    }

    private func migrateTitleRatingToSeason(_ seasonNumber: Int) {
        guard let uid = session.firebaseUser?.uid,
              let existing = viewModel.currentUserTitleRating else {
            return
        }
        Task {
            await viewModel.migrateTitleRating(existing, toSeason: seasonNumber, userID: uid)
        }
    }

    private func toggleWatchlist() {
        guard let uid = session.firebaseUser?.uid else {
            shell.presentAuth()
            return
        }

        if viewModel.isInRewatch {
            Task {
                await viewModel.setRewatchIntent(userID: uid, isIncluded: false)
            }
            return
        }

        if let personalState = viewModel.personalState,
           personalState.hasStartedWatching,
           !personalState.generalWatchlist {
            isSeenWatchlistRoutingPresented = true
            return
        }

        Task {
            await viewModel.toggleWatchlist(userID: uid)
        }
    }

    private func openWatchActions() {
        guard session.firebaseUser?.uid != nil else {
            shell.presentAuth()
            return
        }
        isWatchActionsSheetPresented = true
    }

    private func openEditorialEditor() {
        guard session.appUser?.canEditTitleEditorialContent == true else { return }
        isEditorialSheetPresented = true
    }

    private func quickRateTitle(_ value: Double) {
        guard let uid = session.firebaseUser?.uid else {
            shell.presentAuth()
            return
        }
        Task {
            let saved = await viewModel.submitRating(
                userID: uid,
                level: "title",
                value: value
            )
            guard saved else { return }
            ratingComposerInitialRating = value
            pendingQuickRatingValue = value
            pendingQuickSeasonNumber = nil
            isQuickRatingReviewPromptPresented = true
        }
    }

    private func quickRateSeason(_ seasonNumber: Int, _ value: Double) {
        guard let uid = session.firebaseUser?.uid else {
            shell.presentAuth()
            return
        }
        Task {
            let saved = await viewModel.submitRating(
                userID: uid,
                level: "season",
                season: seasonNumber,
                value: value
            )
            guard saved else { return }
            ratingComposerInitialRating = value
            pendingQuickRatingValue = value
            pendingQuickSeasonNumber = seasonNumber
            isQuickRatingReviewPromptPresented = true
        }
    }

    private func quickRateEpisode(_ seasonNumber: Int, _ episodeNumber: Int, _ value: Double) async -> Bool {
        guard let uid = session.firebaseUser?.uid else {
            shell.presentAuth()
            return false
        }
        return await viewModel.submitRating(
            userID: uid,
            level: "episode",
            season: seasonNumber,
            episode: episodeNumber,
            value: value
        )
    }

    private func toggleSeason(_ seasonNumber: Int) {
        withAnimation(.spring(response: 0.32, dampingFraction: 0.88)) {
            if expandedSeasonNumber == seasonNumber {
                expandedSeasonNumber = nil
            } else {
                expandedSeasonNumber = seasonNumber
            }
        }
    }

    private func openRecommendation() {
        guard session.firebaseUser?.uid != nil else {
            shell.presentAuth()
            return
        }
        isRecommendationSheetPresented = true
    }

    private func openGroupDiscussion() {
        guard session.firebaseUser?.uid != nil else {
            shell.presentAuth()
            return
        }
        isGroupSheetPresented = true
    }
}

private struct TitleDetailTourStep {
    let eyebrow: String
    let title: String
    let message: String
    let systemImage: String
}

private struct TitleDetailWhatsNewSheet: View {
    let onSkip: () -> Void
    let onFinish: () -> Void

    @State private var stepIndex = -1

    private let steps = [
        TitleDetailTourStep(
            eyebrow: "Il tuo percorso",
            title: "Tutto quello che stai guardando, subito",
            message: "Stato, progresso e azioni rapide sono raccolti sotto il titolo.",
            systemImage: "play.circle.fill"
        ),
        TitleDetailTourStep(
            eyebrow: "Aggiornamenti",
            title: "Trailer e uscite hanno un posto dedicato",
            message: "Lo storico del titolo resta separato dagli episodi e dalla community.",
            systemImage: "clock.badge"
        ),
        TitleDetailTourStep(
            eyebrow: "Azioni rapide",
            title: "I tre puntini restano il centro di gestione",
            message: "Liste, rewatch e altre azioni sono ancora lì, in una vista più compatta.",
            systemImage: "ellipsis.circle.fill"
        ),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if stepIndex >= 0 {
                HStack(spacing: 6) {
                    ForEach(steps.indices, id: \.self) { index in
                        Capsule()
                            .fill(index <= stepIndex ? TwoWatchTheme.accent : Color.white.opacity(0.12))
                            .frame(width: 24, height: 4)
                    }
                }
                .padding(.bottom, 18)
            }

            HStack(alignment: .top, spacing: 14) {
                Image(systemName: currentSystemImage)
                    .font(.title3.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.accent)
                    .frame(width: 44, height: 44)
                    .background(TwoWatchTheme.accent.opacity(0.12), in: Circle())

                VStack(alignment: .leading, spacing: 7) {
                    Text(currentEyebrow)
                        .font(.caption.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.accent)
                        .textCase(.uppercase)

                    Text(currentTitle)
                        .font(.title3.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)

                    Text(currentMessage)
                        .font(.subheadline)
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            Spacer(minLength: 18)

            HStack(spacing: 10) {
                Button("Salta", action: onSkip)
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                    .frame(maxWidth: .infinity, minHeight: 46)
                    .background(TwoWatchTheme.panel, in: RoundedRectangle(cornerRadius: 15, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 15, style: .continuous)
                            .stroke(TwoWatchTheme.border, lineWidth: 1)
                    )

                Button(nextButtonTitle) {
                    if stepIndex == steps.count - 1 {
                        onFinish()
                    } else {
                        withAnimation(.easeInOut(duration: 0.2)) {
                            stepIndex += 1
                        }
                    }
                }
                .font(.subheadline.weight(.bold))
                .foregroundStyle(TwoWatchTheme.background)
                .frame(maxWidth: .infinity, minHeight: 46)
                .background(TwoWatchTheme.textPrimary, in: RoundedRectangle(cornerRadius: 15, style: .continuous))
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 22)
        .padding(.bottom, 16)
        .accessibilityElement(children: .contain)
    }

    private var currentStep: TitleDetailTourStep? {
        guard steps.indices.contains(stepIndex) else { return nil }
        return steps[stepIndex]
    }

    private var currentEyebrow: String { currentStep?.eyebrow ?? "Novità" }
    private var currentTitle: String { currentStep?.title ?? "La scheda titolo è cambiata" }
    private var currentMessage: String {
        currentStep?.message ?? "Abbiamo aggiornato questa schermata. Puoi vedere cosa è cambiato oppure esplorarla da solo."
    }
    private var currentSystemImage: String { currentStep?.systemImage ?? "sparkles" }
    private var nextButtonTitle: String {
        if stepIndex < 0 { return "Mostrami le novità" }
        return stepIndex == steps.count - 1 ? "Chiudi" : "Avanti"
    }
}

/// Le azioni che la scheda titolo propaga alle sue sezioni.
///
/// Prima erano 17 closure sciolte fra i parametri di `TitleDetailScreen`, che
/// con gli altri dati faceva 28 argomenti: una firma che nessuno rilegge, e a
/// cui ogni sezione nuova ne aggiungeva un altro. Raggruppate qui la firma
/// scende a 12, e aggiungere un'azione non tocca piu' il call site.

struct TitleDetailActions {
    let onSelectTab: (TitleDetailTab) -> Void
    let onToggleDescription: () -> Void
    let onToggleWatchlist: () -> Void
    let onOpenWatchActions: () -> Void
    let onShowAllCast: () -> Void
    let onVoteCharacters: () -> Void
    let onOpenEditorialEditor: () -> Void
    let onOpenRatingComposer: () -> Void
    let onQuickRateTitle: (Double) -> Void
    let onQuickRateSeason: (Int, Double) -> Void
    let onQuickRateEpisode: (Int, Int, Double) async -> Bool
    let onToggleSeason: (Int) -> Void
    let onSuggestToFriend: () -> Void
    let onOpenGroupDiscussion: () -> Void
    let onOpenFriendsVotes: () -> Void
    let onOpenSeasonRatingComposer: (Int) -> Void
    let onMigrateTitleRatingToSeason: (Int) -> Void
}

private struct TitleDetailScreen: View {
    let title: Title
    let viewModel: TitleDetailViewModel
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore
    let topSafeArea: CGFloat
    let availableWidth: CGFloat
    let selectedTab: TitleDetailTab
    let isDescriptionExpanded: Bool
    let expandedSeasonNumber: Int?
    let actions: TitleDetailActions

    // F-B — CTA quiz sul titolo + prompt post-visto.
    @State private var titleHasQuiz = false
    @State private var showsTitleQuizPlayer = false
    @State private var showsPostSeenQuizPrompt = false

    // Emozioni post-visione — prompt compatto dopo "segna come visto"/
    // "completato". Sequenziato PRIMA del quiz prompt (emozioni poi quiz).
    // Usato solo se l'utente HA già un voto sul titolo: senza voto si apre
    // invece il composer completo (vedi showsPostSeenComposer).
    @State private var showsPostSeenEmotionPrompt = false
    @State private var isCheckingExistingEmotions = false

    // Composer recensione aperto subito dopo "visto"/"completata" quando il
    // titolo non ha ancora un voto (parità con la PWA: voto facoltativo
    // dentro al composer). Il quiz prompt parte alla sua chiusura.
    @State private var showsPostSeenComposer = false

    // Discussione episodio: target aperto dall'azione "Commenti" nell'action
    // sheet episodio. Presentato come sheet NavigationStack con seed .episode.
    @State private var episodeThreadTarget: EpisodeThreadTarget?

    // Voto episodio: sheet compatto aperto dalla riga episodio (stella) o dal
    // nudge post-visto.
    @State private var episodeRatingTarget: EpisodeRatingTarget?

    private var isCompactWidth: Bool {
        availableWidth <= 430
    }

    private var horizontalPadding: CGFloat {
        isCompactWidth ? 16 : 20
    }

    private var availableTabs: [TitleDetailTab] {
        if title.type == .tv {
            return [.overview, .episodes, .updates, .community]
        }
        return [.overview, .updates, .community]
    }

    var body: some View {
        VStack(spacing: isCompactWidth ? 20 : 24) {
            TitleHeroHeader(
                title: title,
                subtitle: TitleDetailFormatter.subtitle(for: title, seasons: viewModel.seasons),
                originalTitle: TitleDetailFormatter.originalTitle(for: title),
                genres: TitleDetailFormatter.displayGenres(for: title, resolvedGenres: viewModel.resolvedGenres),
                personalState: viewModel.personalState,
                isInWatchlist: viewModel.isInWatchlist,
                isInRewatch: viewModel.isInRewatch,
                userRating: viewModel.currentUserTitleRatingValue,
                communityAverageText: viewModel.communityAverageText,
                communityVotesCount: viewModel.communityVotesCount,
                friendsAverageText: viewModel.friendsAverageText,
                friendsVotesCount: viewModel.friendsVotesCount,
                expertsAverageText: viewModel.expertsAverageText,
                expertsVotesCount: viewModel.expertsVotesCount,
                topSafeArea: topSafeArea,
                availableWidth: availableWidth,
                onToggleWatchlist: actions.onToggleWatchlist,
                onOpenWatchActions: actions.onOpenWatchActions,
                onOpenRatingComposer: actions.onOpenRatingComposer,
                onOpenFriendsVotes: actions.onOpenFriendsVotes
            )

            VStack(spacing: 18) {
                TitlePersonalTrackingSection(
                    title: title,
                    personalState: viewModel.personalState,
                    isAuthenticated: session.firebaseUser?.uid != nil,
                    onRequireAuth: shell.presentAuth,
                    onOpenWatchActions: actions.onOpenWatchActions,
                    onOpenRatingComposer: actions.onOpenRatingComposer,
                    onMarkMovieSeen: {
                        withAuthenticatedUser { uid in
                            Task {
                                await viewModel.markMovieSeen(userID: uid)
                                await presentPostSeenPromptsIfNeeded(userID: uid)
                            }
                        }
                    },
                    onConfirmUnsee: {
                        withAuthenticatedUser { uid in
                            Task { await viewModel.markUnseen(userID: uid) }
                        }
                    },
                    onToggleWatchlist: {
                        withAuthenticatedUser { uid in
                            Task { await viewModel.toggleWatchlist(userID: uid) }
                        }
                    },
                    onMarkSeriesEpisode: {
                        withAuthenticatedUser { uid in
                            Task {
                                let previousCount = viewModel.personalState?.seriesProgress?.episodesWatchedCount ?? 0
                                await viewModel.markSeriesEpisodeWatched(userID: uid)
                                presentEpisodeSeenAfterAtomicAdvance(
                                    previousEpisodeCount: previousCount,
                                    source: "title_detail_quick_add"
                                )
                            }
                        }
                    },
                    onMarkSeriesSeason: {
                        withAuthenticatedUser { uid in
                            Task { await viewModel.markSeriesSeasonWatched(userID: uid) }
                        }
                    },
                    onMarkSeriesCompleted: {
                        withAuthenticatedUser { uid in
                            Task {
                                await viewModel.markSeriesCompleted(userID: uid)
                                await presentPostSeenPromptsIfNeeded(userID: uid)
                            }
                        }
                    },
                    onSetRewatchIntent: { isIncluded in
                        withAuthenticatedUser { uid in
                            Task { await viewModel.setRewatchIntent(userID: uid, isIncluded: isIncluded) }
                        }
                    },
                    onAcknowledgeNewContent: {
                        withAuthenticatedUser { uid in
                            Task { await viewModel.acknowledgeNewContent(userID: uid) }
                        }
                    },
                    onResumeFromNewContent: {
                        withAuthenticatedUser { uid in
                            Task {
                                let previousCount = viewModel.personalState?.seriesProgress?.episodesWatchedCount ?? 0
                                await viewModel.markSeriesEpisodeWatched(userID: uid)
                                presentEpisodeSeenAfterAtomicAdvance(
                                    previousEpisodeCount: previousCount,
                                    source: "title_detail_resume"
                                )
                            }
                        }
                    }
                )

                if titleHasQuiz {
                    TitleQuizCTAButton(titleName: title.name) {
                        showsTitleQuizPlayer = true
                    }
                }

                TitleDetailTabBar(
                    tabs: availableTabs,
                    selectedTab: selectedTab,
                    onSelectTab: actions.onSelectTab
                )

                Group {
                    switch selectedTab {
                    case .overview:
                        VStack(spacing: 18) {
                            TitleOverviewSection(
                                overview: title.description,
                                trailerURL: viewModel.trailerURL,
                                isLoadingTrailer: viewModel.isLoadingTrailer,
                                canEditEditorialContent: session.appUser?.canEditTitleEditorialContent ?? false,
                                isExpanded: isDescriptionExpanded,
                                onToggleExpanded: actions.onToggleDescription,
                                onOpenEditor: actions.onOpenEditorialEditor
                            )

                            TitleQuickMetadataSection(
                                title: title,
                                seasons: viewModel.seasons,
                                isCompactWidth: isCompactWidth
                            )

                            if let providers = resolvedProviders(for: title) {
                                TitleWatchProvidersSection(
                                    providers: providers,
                                    fallbackPlatformName: title.metadata.network,
                                    titleName: title.name,
                                    tmdbId: title.metadata.tmdbId,
                                    isSeries: title.type == .tv
                                )
                            } else if viewModel.isLoadingProviders {
                                TitleWatchProvidersSkeleton()
                            }

                            if !viewModel.directorCredits.isEmpty || !viewModel.castCredits.isEmpty {
                                TitleCreditsSection(
                                    directorCredits: viewModel.directorCredits,
                                    castCredits: viewModel.castCredits,
                                    container: container,
                                    session: session,
                                    shell: shell,
                                    characterBucket: viewModel.characterBucket,
                                    voteCtaTitle: castVoteCtaTitle(for: title),
                                    onShowAllCast: actions.onShowAllCast,
                                    onVoteCharacters: actions.onVoteCharacters
                                )
                            } else if viewModel.isLoadingCredits {
                                TitleCreditsSkeleton()
                            }

                            TitleRelatedCarouselSection(
                                relatedTitles: viewModel.relatedTitles,
                                container: container,
                                session: session,
                                shell: shell
                            )
                        }

                    case .episodes:
                        VStack(spacing: 18) {
                            if title.type == .tv {
                                TitleSeriesSeasonsSection(
                                    title: title,
                                    container: container,
                                    seasons: viewModel.seasons,
                                    isLoadingSeasons: viewModel.isLoadingSeasons,
                                    personalState: viewModel.personalState,
                                    viewModel: viewModel,
                                    isAuthenticated: session.firebaseUser?.uid != nil,
                                    isCompactWidth: isCompactWidth,
                                    onSelectSeasonRating: actions.onQuickRateSeason,
                                    onSelectEpisodeProgress: { seasonNumber, episodeNumber in
                                        withAuthenticatedUser { uid in
                                            let payload = seriesProgressPayload(
                                                seasons: viewModel.seasons,
                                                seasonNumber: seasonNumber,
                                                episodeNumber: episodeNumber
                                            )
                                            guard let payload else { return }
                                            // Solo un avanzamento di +1 episodio è "ho
                                            // appena visto questo": toccare un episodio
                                            // lontano è un allineamento della libreria e
                                            // non deve far comparire il foglio.
                                            let previousCount = viewModel.personalState?.seriesProgress?.episodesWatchedCount ?? 0
                                            Task {
                                                await viewModel.setSeriesProgress(
                                                    userID: uid,
                                                    watchedEpisodesCount: payload.episodesWatchedCount,
                                                    completedSeasonsCount: payload.seasonsCompletedCount,
                                                    lastWatchedSeasonNumber: payload.lastWatchedSeasonNumber,
                                                    lastWatchedEpisodeNumber: payload.lastWatchedEpisodeNumber,
                                                    source: "title_detail_episode_grid"
                                                )
                                                presentEpisodeSeenAfterAtomicAdvance(
                                                    previousEpisodeCount: previousCount,
                                                    source: "title_detail_episode_grid"
                                                )
                                            }
                                        }
                                    },
                                    onMarkSeriesUnstarted: {
                                        withAuthenticatedUser { uid in
                                            Task { await viewModel.markSeriesUnstarted(userID: uid) }
                                        }
                                    },
                                    onMarkSeasonCompleted: { seasonNumber in
                                        withAuthenticatedUser { uid in
                                            guard let season = viewModel.seasons.first(where: { $0.seasonNumber == seasonNumber }) else { return }
                                            let payload = seriesProgressPayload(
                                                seasons: viewModel.seasons,
                                                seasonNumber: seasonNumber,
                                                episodeNumber: max(1, season.episodeCount)
                                            )
                                            guard let payload else { return }
                                            Task {
                                                await viewModel.setSeriesProgress(
                                                    userID: uid,
                                                    watchedEpisodesCount: payload.episodesWatchedCount,
                                                    completedSeasonsCount: payload.seasonsCompletedCount,
                                                    lastWatchedSeasonNumber: payload.lastWatchedSeasonNumber,
                                                    lastWatchedEpisodeNumber: payload.lastWatchedEpisodeNumber,
                                                    source: "title_detail_season_complete"
                                                )
                                            }
                                        }
                                    },
                                    onOpenEpisodeRating: { seasonNumber, episodeNumber in
                                        withAuthenticatedUser { _ in
                                            episodeRatingTarget = EpisodeRatingTarget(
                                                season: seasonNumber,
                                                episode: episodeNumber
                                            )
                                        }
                                    },
                                    onOpenEpisodeComments: { seasonNumber, episodeNumber in
                                        guard session.firebaseUser?.uid != nil else {
                                            shell.presentAuth()
                                            return
                                        }
                                        episodeThreadTarget = EpisodeThreadTarget(
                                            season: seasonNumber,
                                            episode: episodeNumber
                                        )
                                    },
                                    onDeleteEpisodeRating: { seasonNumber, episodeNumber in
                                        withAuthenticatedUser { uid in
                                            Task {
                                                await viewModel.deleteRating(
                                                    userID: uid,
                                                    level: "episode",
                                                    season: seasonNumber,
                                                    episode: episodeNumber
                                                )
                                            }
                                        }
                                    },
                                    onRequestAuth: shell.presentAuth
                                )
                            } else {
                                TitleSectionCard {
                                    SectionEmptyStateView(
                                        title: "Nessun episodio disponibile",
                                        message: "Per i film qui non mostriamo il tab episodi.",
                                        systemImage: "film"
                                    )
                                }
                            }
                        }

                    case .updates:
                        TitleUpdatesSection(
                            snapshot: viewModel.updates,
                            isLoading: viewModel.isUpdatesLoading,
                            errorMessage: viewModel.updatesErrorMessage,
                            preference: viewModel.titleUpdatePreference,
                            isSavingPreference: viewModel.isSavingTitleUpdatePreference,
                            canManagePreference: session.firebaseUser?.uid != nil,
                            onRetry: {
                                Task { await viewModel.retryTitleUpdates() }
                            },
                            onOpenOfficialUpdate: { postID in
                                _ = shell.present(
                                    destination: .post(id: postID),
                                    currentUserID: session.firebaseUser?.uid
                                )
                            },
                            onSetPreference: { preference in
                                guard let uid = session.firebaseUser?.uid else {
                                    shell.presentAuth()
                                    return
                                }
                                Task { await viewModel.setTitleUpdatePreference(preference, userID: uid) }
                            }
                        )

                    case .community:
                        VStack(spacing: 18) {
                            TitleSocialStatsSection(
                                viewModel: viewModel,
                                isAuthenticated: session.firebaseUser?.uid != nil,
                                isCompactWidth: isCompactWidth,
                                onOpenFriendsVotes: actions.onOpenFriendsVotes
                            )

                            // In alto, non in fondo: era la richiesta più
                            // frequente ("apro un titolo e voglio vedere le
                            // discussioni aperte"), e prima era un link di
                            // testo sepolto sotto le review.
                            TitleDiscussionsCard(
                                title: title,
                                container: container,
                                session: session,
                                shell: shell,
                                isAuthenticated: session.firebaseUser?.uid != nil,
                                onRequestAuth: shell.presentAuth
                            )

                            TitleEmotionCommunitySection(
                                title: title,
                                container: container,
                                session: session,
                                personalState: viewModel.personalState
                            )

                            TitleCharacterSection(
                                title: title,
                                container: container,
                                session: session,
                                personalState: viewModel.personalState
                            )

                            if title.type == .tv, !viewModel.watchers.isEmpty {
                                TitleWatchersSection(
                                    watchers: viewModel.watchers,
                                    container: container,
                                    session: session,
                                    shell: shell
                                )
                            }

                            if !viewModel.publicListsContainingTitle.isEmpty {
                                TitlePublicListsSection(
                                    lists: viewModel.publicListsContainingTitle,
                                    onOpenList: { list in
                                        shell.present(
                                            destination: .publicList(slug: list.shareSlug),
                                            currentUserID: session.firebaseUser?.uid
                                        )
                                    }
                                )
                            }

                            TitleRatingComposerSection(
                                viewModel: viewModel,
                                titleID: title.id,
                                isAuthenticated: session.firebaseUser?.uid != nil,
                                container: container,
                                session: session,
                                shell: shell,
                                onSelectRating: actions.onQuickRateTitle,
                                onOpenReview: actions.onOpenRatingComposer,
                                onRequestAuth: shell.presentAuth
                            )

                            // Per le serie: se l'utente ha già voti per stagione
                            // o un voto generale, mostra il breakdown con
                            // possibilità di migrare il voto generale su una
                            // stagione specifica.
                            if title.type == .tv,
                               session.firebaseUser?.uid != nil,
                               !viewModel.currentUserSeasonRatings.isEmpty
                                || viewModel.currentUserTitleRating != nil
                                || viewModel.derivedRating?.seriesAvg != nil {
                                MyRatingsBreakdownView(
                                    titleLevelRating: viewModel.currentUserTitleRating,
                                    seasonRatings: viewModel.currentUserSeasonRatings,
                                    availableSeasons: viewModel.availableSeasonNumbers,
                                    derivedRating: viewModel.derivedRating,
                                    onTapSeasonRating: actions.onOpenSeasonRatingComposer,
                                    onMigrateToSeason: actions.onMigrateTitleRatingToSeason,
                                    onAddSeasonRating: actions.onOpenSeasonRatingComposer,
                                    onRemoveTitleRating: {
                                        guard let uid = session.firebaseUser?.uid else { return }
                                        Task { await viewModel.deleteTitleRating(userID: uid) }
                                    },
                                    onRemoveSeasonRating: { season in
                                        guard let uid = session.firebaseUser?.uid else { return }
                                        Task { await viewModel.deleteSeasonRating(userID: uid, season: season) }
                                    }
                                )
                            }

                            if let currentUserReview = viewModel.currentUserTitleRating,
                               (currentUserReview.reviewText ?? "")
                                .trimmingCharacters(in: .whitespacesAndNewlines)
                                .isEmpty == false {
                                TitlePersonalReviewSection(
                                    review: currentUserReview,
                                    onEditReview: actions.onOpenRatingComposer
                                )
                            }

                            TitleCommunityReviewsSection(
                                reviews: viewModel.reviews,
                                titleID: title.id,
                                isAuthenticated: session.firebaseUser?.uid != nil,
                                container: container,
                                session: session,
                                shell: shell,
                                onWriteReview: actions.onOpenRatingComposer,
                                onRequestAuth: shell.presentAuth
                            )

                            TitleSocialActionsSection(
                                title: title,
                                container: container,
                                session: session,
                                shell: shell,
                                onSuggestToFriend: actions.onSuggestToFriend,
                                onOpenGroupDiscussion: actions.onOpenGroupDiscussion
                            )
                        }
                    }
                }
            }
            .padding(.horizontal, horizontalPadding)
        }
        .overlay(alignment: .top) {
            if let pendingActionLabel = viewModel.pendingActionLabel {
                ZStack(alignment: .top) {
                    Color.black.opacity(0.08)
                        .contentShape(Rectangle())
                        .onTapGesture {}

                    HStack(spacing: 10) {
                        ProgressView()
                            .tint(TwoWatchTheme.textPrimary)
                        Text(pendingActionLabel)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(TwoWatchTheme.textPrimary)
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                    .background(.ultraThinMaterial, in: Capsule())
                    .overlay(Capsule().stroke(TwoWatchTheme.border, lineWidth: 1))
                    .padding(.top, 12)
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel(pendingActionLabel)
                }
            }
        }
        .task {
            // Membership in quizMeta/themes (1 read, ~200 voci). Cheap come la CTA web.
            let themes = (try? await container.quizRepository.fetchAllPlayableThemes()) ?? []
            titleHasQuiz = themes.contains { $0.titleId == title.id }
        }
        .fullScreenCover(isPresented: $showsTitleQuizPlayer) {
            NavigationStack {
                QuizPlayView(
                    container: container,
                    session: session,
                    shell: shell,
                    mode: .solo,
                    challenge: nil,
                    selectedTitleId: title.id,
                    questionCount: 5
                )
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Chiudi") { showsTitleQuizPlayer = false }
                    }
                }
            }
        }
        .sheet(isPresented: $showsPostSeenQuizPrompt) {
            PostSeenQuizPromptView(
                titleName: title.name,
                onPlay: {
                    showsPostSeenQuizPrompt = false
                    showsTitleQuizPlayer = true
                }
            )
            .presentationDetents([.height(300)])
            .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showsPostSeenEmotionPrompt, onDismiss: presentQuizPromptIfNeeded) {
            if let uid = session.firebaseUser?.uid {
                PostSeenEmotionPromptSheet(
                    container: container,
                    userID: uid,
                    titleID: title.id,
                    titleName: title.name
                )
                .presentationDetents([.medium])
                .presentationDragIndicator(.visible)
            }
        }
        .sheet(isPresented: $showsPostSeenComposer, onDismiss: presentQuizPromptIfNeeded) {
            if let uid = session.firebaseUser?.uid {
                RatingPostComposerSheet(
                    container: container,
                    currentUserID: uid,
                    currentUserName: session.appUser?.displayName ?? session.firebaseUser?.displayName ?? "User",
                    title: title,
                    existingRating: viewModel.currentUserTitleRating,
                    hasAcceptedCommunitySafety: session.appUser?.hasAcceptedCommunitySafetyTerms == true,
                    initialRating: nil
                ) {
                    Task { await viewModel.load(currentUserID: session.firebaseUser?.uid) }
                }
            }
        }
        .sheet(item: $episodeThreadTarget) { target in
            NavigationStack {
                ThreadDetailView(
                    container: container,
                    session: session,
                    shell: shell,
                    threadID: container.threadsRepository.threadIDForEpisode(
                        titleID: title.id,
                        season: target.season,
                        episode: target.episode
                    ),
                    publicThreadSeed: .episode(
                        titleID: title.id,
                        season: target.season,
                        episode: target.episode
                    )
                )
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Chiudi") { episodeThreadTarget = nil }
                            .foregroundStyle(TwoWatchTheme.textPrimary)
                    }
                }
            }
        }
        .sheet(item: $episodeRatingTarget) { target in
            EpisodeRatingSheet(
                season: target.season,
                episode: target.episode,
                personalRating: viewModel.rating(level: "episode", season: target.season, episode: target.episode)?.rating,
                communityAverage: viewModel.average(level: "episode", season: target.season, episode: target.episode),
                onSelect: { value in await actions.onQuickRateEpisode(target.season, target.episode, value) },
                onDelete: {
                    withAuthenticatedUser { uid in
                        Task {
                            await viewModel.deleteRating(
                                userID: uid,
                                level: "episode",
                                season: target.season,
                                episode: target.episode
                            )
                        }
                    }
                }
            )
            .presentationDetents([.height(340)])
            .presentationDragIndicator(.visible)
        }
    }

    private func presentEpisodeSeenAfterAtomicAdvance(
        previousEpisodeCount: Int,
        source: String
    ) {
        let progress = viewModel.personalState?.seriesProgress
        let existingRating: Double?
        if let season = progress?.lastWatchedSeasonNumber,
           let episode = progress?.lastWatchedEpisodeNumber {
            existingRating = viewModel.rating(
                level: "episode",
                season: season,
                episode: episode
            )?.rating
        } else {
            existingRating = nil
        }
        container.episodeSeenCoordinator.presentAfterAtomicAdvance(
            title: title,
            previousEpisodeCount: previousEpisodeCount,
            updatedProgress: progress,
            completesSeries: viewModel.personalState?.isCompleted == true,
            hasTitleRating: viewModel.currentUserTitleRating != nil
                || viewModel.personalState?.hasTitleRating == true,
            source: source,
            existingEpisodeRating: existingRating
        )
    }

    /// Dopo "segna come visto"/"completato": se il titolo non ha ancora un
    /// voto apre il composer completo (voto facoltativo dentro, parità PWA);
    /// altrimenti, se mancano le emozioni, il prompt compatto. Il quiz prompt
    /// (se applicabile) parte SOLO dopo la chiusura dello sheet mostrato
    /// (vedi `onDismiss` sopra), mai in contemporanea.
    private func presentPostSeenPromptsIfNeeded(userID: String) async {
        if viewModel.currentUserTitleRating == nil {
            showsPostSeenComposer = true
            return
        }

        isCheckingExistingEmotions = true
        let existing = (try? await container.titleRepository.fetchMyTitleEmotions(
            userID: userID,
            titleID: title.id
        )) ?? []
        isCheckingExistingEmotions = false

        if existing.isEmpty {
            showsPostSeenEmotionPrompt = true
        } else {
            presentQuizPromptIfNeeded()
        }
    }

    private func presentQuizPromptIfNeeded() {
        if titleHasQuiz {
            showsPostSeenQuizPrompt = true
        }
    }

    private func resolvedProviders(for title: Title) -> TitleProviders? {
        if let providers = viewModel.providers, !providers.isEmpty {
            return providers
        }
        return fallbackProviders(for: title)
    }

    private func fallbackProviders(for title: Title) -> TitleProviders? {
        guard let network = title.metadata.network?.trimmingCharacters(in: .whitespacesAndNewlines), !network.isEmpty else {
            return nil
        }

        return TitleProviders(
            region: "IT",
            link: nil,
            providers: [],
            customProviders: [
                StreamingProvider(
                    id: "fallback-\(network)",
                    name: network,
                    logoURL: nil,
                    type: "fallback"
                )
            ]
        )
    }

    private func withAuthenticatedUser(_ action: (String) -> Void) {
        guard let uid = session.firebaseUser?.uid else {
            shell.presentAuth()
            return
        }
        action(uid)
    }
}

#if DEBUG
#Preview("Title Detail") {
    NavigationStack {
        TitleDetailView(
            container: TwoWatchPreview.container,
            session: TwoWatchPreview.session(),
            shell: TwoWatchPreview.shell(),
            titleID: TwoWatchPreview.secondTitle.id,
            previewViewModel: TwoWatchPreview.titleDetailViewModel()
        )
    }
}
#endif
