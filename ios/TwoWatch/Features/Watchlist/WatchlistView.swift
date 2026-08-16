import Observation
@preconcurrency import FirebaseStorage
import ImageIO
import PhotosUI
import SwiftUI


struct WatchlistView: View {
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore
    private let disablesAutomaticLoading: Bool
    @State private var viewModel: WatchlistViewModel
    @State private var selectedCoverItem: PhotosPickerItem?
    @State private var isShowingPublicListsBrowser = false
    @State private var pendingPublicListIDToOpen: String?
    @State private var pendingQuickAddTitle: Title?
    @State private var activeQuickIdea: WatchlistQuickIdeaKind?
    @State private var toWatchFilter: WatchlistToWatchFilter = .toWatch
    @State private var toWatchSort: WatchlistToWatchSort = .recentlyAdded
    @State private var toWatchLayout: WatchlistToWatchLayout = .grid
    @State private var toWatchPlatform: String? = nil
    @State private var groupByPlatform: Bool = false
    /// La coda intera spingeva liste e scoperta fuori schermo: si parte da
    /// un blocco e si espande su richiesta.
    @State private var showsAllQueue = false
    @State private var createListTipService = WatchlistCreateListTipService()
    @State private var isCreateListTipDismissed = false
    @State private var welcomeService = WatchlistWelcomeService()
    @State private var isWelcomeDismissed = false
    /// Modale esplicativo mostrato una sola volta al primo ingresso in Watchlist:
    /// spiega watchlist vs liste personalizzate e dove ritrovare i titoli visti.
    @AppStorage(SomtoDefaultsKey.watchlistIntroSeen) private var watchlistIntroSeen = false
    @State private var showWatchlistIntro = false

    init(container: AppContainer, session: SessionStore, shell: AppShellStore) {
        self.container = container
        self.session = session
        self.shell = shell
        disablesAutomaticLoading = false
        _viewModel = State(initialValue: WatchlistViewModel(
            watchlistRepository: container.watchlistRepository,
            titleRepository: container.titleRepository,
            analytics: container.analytics,
            spotlightIndexer: container.spotlightIndexer
        ))
    }

#if DEBUG
    init(
        container: AppContainer,
        session: SessionStore,
        shell: AppShellStore,
        previewViewModel: WatchlistViewModel
    ) {
        self.container = container
        self.session = session
        self.shell = shell
        disablesAutomaticLoading = true
        _viewModel = State(initialValue: previewViewModel)
    }
#endif

    var body: some View {
        ScrollViewReader { proxy in
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                if !session.isAuthenticated {
                    EmptyStateView(
                        title: "Area personale",
                        message: "Watchlist, Rewatch e liste personali vivono nel tuo profilo. Accedi per continuare.",
                        systemImage: "bookmark.slash.fill",
                        actionTitle: "Accedi"
                    ) {
                        shell.presentAuth()
                    }
                    .padding(.top, 6)
                } else {
                    // Watchlist vNext: niente picker a 4 aree. La Home è una sola
                    // schermata; "Da vedere" e "Condivise" restano come schermate
                    // di dettaglio, raggiunte dalla card "Tutta la watchlist" e da
                    // "Le tue liste", con un back esplicito.
                    if viewModel.selectedArea != .home {
                        Button {
                            viewModel.selectedArea = .home
                        } label: {
                            HStack(spacing: 5) {
                                Image(systemName: "chevron.left")
                                    .font(.footnote.weight(.bold))
                                Text("Watchlist")
                                    .font(.subheadline.weight(.semibold))
                            }
                            .foregroundStyle(TwoWatchTheme.textSecondary)
                        }
                        .buttonStyle(.plain)
                    }

                    if let ratingPromptTitle = viewModel.ratingPromptTitle {
                        WatchlistRatingReminderBanner(
                            title: ratingPromptTitle,
                            onOpenRating: {
                                viewModel.openRatingPrompt(for: ratingPromptTitle)
                            },
                            onDismiss: {
                                viewModel.dismissRatingPrompt()
                            }
                        )
                    }

                    selectedAreaContent
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 72)
            .padding(.bottom, 120)
            .preference(key: ChromeBarHiddenPreferenceKey.self, value: showsInitialLoadingOverlay)
            .id("watchlist-top")
        }
        .contentMargins(.horizontal, 20, for: .scrollContent)
        .background(TwoWatchBackground())
        .scrollIndicators(.hidden)
        // Le sotto-schermate (Da vedere, Le tue liste) non sono push di
        // NavigationStack ma cambi di stato: senza questo l'unico modo di
        // tornare indietro è il bottone in alto, e lo swipe dal bordo non fa
        // nulla. `simultaneousGesture` non ruba lo scroll verticale.
        .simultaneousGesture(
            DragGesture(minimumDistance: 20, coordinateSpace: .global)
                .onEnded { value in
                    guard viewModel.selectedArea != .home else { return }
                    guard value.startLocation.x < 60 else { return }
                    guard value.translation.width > 80,
                          abs(value.translation.height) < 70 else { return }
                    withAnimation(.easeOut(duration: 0.22)) {
                        viewModel.selectedArea = .home
                    }
                }
        )
        .clipped()
        .toolbar(.hidden, for: .navigationBar)
        .overlay {
            if showsInitialLoadingOverlay {
                // Loader inline scuro al posto dello splash globale chiaro
                // ("Sto preparando Somto…"): niente flash bianco né copy app-level su uno switch tab.
                ZStack {
                    TwoWatchBackground()
                    VStack(spacing: 12) {
                        ProgressView()
                            .controlSize(.large)
                            .tint(.white)
                        Text("Carico la watchlist…")
                            .font(.subheadline)
                            .foregroundStyle(.white.opacity(0.7))
                    }
                }
                .ignoresSafeArea()
                .transition(.opacity)
                .zIndex(1)
            }
        }
        // Feedback immediato all'apertura di una lista: fetchListDetail può
        // metterci un attimo (ricalcolo progressi + titleStates) e il foglio si
        // apre solo a fetch finito → senza questo overlay il tap sembrava non
        // fare nulla ("ci mette un po' e sembra non funzionare").
        .overlay {
            if viewModel.isLoadingList {
                ZStack {
                    Color.black.opacity(0.35).ignoresSafeArea()
                    VStack(spacing: 12) {
                        ProgressView()
                            .controlSize(.large)
                            .tint(.white)
                        Text("Apro la lista…")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.white)
                    }
                    .padding(28)
                    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                }
                .transition(.opacity)
                .zIndex(2)
                .allowsHitTesting(true)
            }
        }
        .animation(.easeInOut(duration: 0.15), value: viewModel.isLoadingList)
        .watchlistActionFeedback(
            pendingMessage: viewModel.pendingActionMessage,
            successMessage: viewModel.successMessage
        )
        .onAppear {
            isCreateListTipDismissed = createListTipService.isDismissed
            isWelcomeDismissed = welcomeService.isDismissed
            if session.isAuthenticated && !watchlistIntroSeen {
                showWatchlistIntro = true
            }
        }
        .sheet(isPresented: $showWatchlistIntro) {
            WatchlistIntroSheet(
                onGoToProfile: {
                    watchlistIntroSeen = true
                    showWatchlistIntro = false
                    shell.selectedTab = .profile
                },
                onClose: {
                    watchlistIntroSeen = true
                    showWatchlistIntro = false
                }
            )
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
        .task {
            guard !disablesAutomaticLoading else { return }
            if let uid = session.firebaseUser?.uid {
                await viewModel.load(userID: uid)
            }
        }
        // Chiave su slug + uid: ri-parte sia quando arriva un nuovo deep link,
        // sia dopo il login (uid passa da nil a valorizzato) → lo slug stashato
        // pre-signup non viene perso.
        .task(id: pendingPublicListConsumeKey) {
            await consumePendingPublicListSlug()
        }
        .refreshable {
            guard !disablesAutomaticLoading else { return }
            if let uid = session.firebaseUser?.uid {
                await viewModel.reload(userID: uid)
            }
        }
        .sheet(item: Binding(
            get: { viewModel.selectedListDetail },
            set: { viewModel.selectedListDetail = $0 }
        )) { detail in
            NavigationStack {
                WatchlistListDetailView(
                    container: container,
                    session: session,
                    shell: shell,
                    detail: detail,
                    viewModel: viewModel
                )
            }
            .watchlistActionFeedback(
                pendingMessage: viewModel.pendingActionMessage,
                successMessage: viewModel.successMessage
            )
            .presentationDetents([.large])
            .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: Binding(
            get: { viewModel.editorMode != nil },
            set: { if !$0 { viewModel.editorMode = nil } }
        )) {
            NavigationStack {
                WatchlistListEditorView(
                    container: container,
                    session: session,
                    viewModel: viewModel,
                    selectedCoverItem: $selectedCoverItem
                )
            }
            .watchlistActionFeedback(
                pendingMessage: viewModel.pendingActionMessage,
                successMessage: viewModel.successMessage
            )
            .presentationDetents([.large])
            .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $isShowingPublicListsBrowser) {
            NavigationStack {
                PublicListsBrowserView(
                    lists: viewModel.dashboard.publicLists,
                    viewModel: viewModel,
                    onOpenList: { list in
                        pendingPublicListIDToOpen = list.id
                        isShowingPublicListsBrowser = false
                    },
                    onTogglePin: { list in
                        guard let uid = session.firebaseUser?.uid else { return }
                        Task { await viewModel.togglePublicListPin(userID: uid, list: list) }
                    }
                )
            }
            .watchlistActionFeedback(
                pendingMessage: viewModel.pendingActionMessage,
                successMessage: viewModel.successMessage
            )
            .presentationDetents([.large])
            .presentationDragIndicator(.visible)
        }
        .sheet(item: Binding(
            get: { viewModel.activeRatingContext },
            set: { viewModel.activeRatingContext = $0 }
        )) { context in
            NavigationStack {
                QuickRatingSheet(
                    title: context.title,
                    onSubmit: { value in
                        guard let uid = session.firebaseUser?.uid else { return }
                        Task { await viewModel.submitRating(userID: uid, title: context.title, value: value) }
                    },
                    onMarkLater: {
                        guard let uid = session.firebaseUser?.uid else { return }
                        Task { await viewModel.deferRating(userID: uid, title: context.title) }
                    }
                )
            }
            .watchlistActionFeedback(
                pendingMessage: viewModel.pendingActionMessage,
                successMessage: viewModel.successMessage
            )
            .presentationDetents([.medium])
            .presentationDragIndicator(.visible)
        }
        .sheet(item: $activeQuickIdea) { idea in
            NavigationStack {
                WatchlistQuickIdeasSheet(
                    idea: idea,
                    states: quickIdeaStates(for: idea),
                    container: container,
                    session: session,
                    shell: shell,
                    genreLookup: viewModel.genreLookup,
                    onClose: { activeQuickIdea = nil },
                    onOpenSearch: {
                        activeQuickIdea = nil
                        shell.presentSearch()
                    }
                )
            }
            .presentationDetents([.large])
            .presentationDragIndicator(.visible)
        }
        .onChange(of: selectedCoverItem) { _, newValue in
            guard let newValue else { return }
            Task {
                guard !viewModel.isPreparingCover else { return }
                viewModel.isPreparingCover = true
                defer { viewModel.isPreparingCover = false }

                do {
                    guard let data = try await newValue.loadTransferable(type: Data.self),
                          let image = UIImage(data: data) else {
                        viewModel.errorMessage = String(localized: "Operazione non riuscita")
                        return
                    }
                    viewModel.pendingCoverImage = image
                } catch {
                    viewModel.errorMessage = UserFacingError.message(for: error)
                }
            }
        }
        .onChange(of: isShowingPublicListsBrowser) { _, isPresented in
            guard !isPresented, let pendingPublicListIDToOpen, let uid = session.firebaseUser?.uid else { return }
            self.pendingPublicListIDToOpen = nil
            Task { await viewModel.openList(userID: uid, listID: pendingPublicListIDToOpen) }
        }
        .confirmationDialog(
            "Aggiungi a una lista",
            isPresented: Binding(
                get: { pendingQuickAddTitle != nil },
                set: { if !$0 { pendingQuickAddTitle = nil } }
            ),
            titleVisibility: .visible
        ) {
            ForEach(viewModel.editableListsForQuickAdd) { list in
                Button(list.title) {
                    guard let uid = session.firebaseUser?.uid, let title = pendingQuickAddTitle else { return }
                    pendingQuickAddTitle = nil
                    Task { await viewModel.addTitleToList(userID: uid, listID: list.id, title: title) }
                }
            }

            Button("Nuova lista") {
                guard let title = pendingQuickAddTitle else { return }
                pendingQuickAddTitle = nil
                viewModel.prepareCreateList(seedTitle: title)
            }

            Button("Annulla", role: .cancel) {
                pendingQuickAddTitle = nil
            }
        } message: {
            if let pendingQuickAddTitle {
                Text("Scegli dove aggiungere \(pendingQuickAddTitle.name).")
            }
        }
        .alert("Errore", isPresented: Binding(get: { viewModel.errorMessage != nil }, set: { _ in viewModel.errorMessage = nil })) {
            Button("Chiudi", role: .cancel) {}
        } message: {
            Text(viewModel.errorMessage ?? "")
        }
        // "Vedi tutte" cambia area programmaticamente: riporta lo scroll in cima,
        // altrimenti si resta all'offset del punto toccato (a metà pagina).
        .onChange(of: viewModel.selectedArea) { _, _ in
            withAnimation(.easeOut(duration: 0.25)) {
                proxy.scrollTo("watchlist-top", anchor: .top)
            }
        }
        }
    }

    private var showsInitialLoadingOverlay: Bool {
        session.isAuthenticated && viewModel.isLoading && viewModel.dashboard == .empty
    }

    private var generalWatchlistSummary: UserListSummary? {
        let states = viewModel.dashboard.generalWatchlist
        guard !states.isEmpty else { return nil }

        let previewTitles = states.compactMap(\.title)

        return UserListSummary(
            id: WatchlistRepository.generalWatchlistListID,
            title: "Tutti i titoli da vedere",
            description: "I titoli che hai segnato da vedere, sempre pronti da riprendere.",
            visibility: .private,
            kind: .collection,
            ownerUid: session.firebaseUser?.uid ?? "",
            owner: nil,
            memberUids: session.firebaseUser.map { [$0.uid] } ?? [],
            editorUids: [],
            cover: UserListCover(
                imageURL: nil,
                storagePath: nil,
                fallbackTitleIds: previewTitles.map(\.id),
                accentHex: nil
            ),
            itemCount: states.count,
            completedCount: states.filter(\.isCompleted).count,
            followersCount: 0,
            createdAt: states.compactMap(\.createdAt).min(),
            updatedAt: states.compactMap { $0.updatedAt ?? $0.lastInteractionAt ?? $0.createdAt }.max(),
            isOwnedByCurrentUser: true,
            canEdit: false,
            isSavedByCurrentUser: true,
            previewTitles: previewTitles
        )
    }

    private var ownedCustomLists: [UserListSummary] {
        viewModel.dashboard.myLists.filter { $0.id != WatchlistRepository.generalWatchlistListID }
    }

    /// Liste dell'utente per la sezione "Le tue liste" (Home), in ordine:
    /// private → condivise (owned .shared + condivise da altri) → pubbliche salvate.
    /// Dedup per id preservando il primo inserimento.
    private var myListsForHome: [UserListSummary] {
        let privateLists = ownedCustomLists.filter { $0.visibility == .private }
        let sharedLists = ownedCustomLists.filter { $0.visibility == .shared }
            + viewModel.dashboard.sharedLists
        let publicSaved = pinnedPublicLists

        var seen: Set<String> = []
        return (privateLists + sharedLists + publicSaved).filter { seen.insert($0.id).inserted }
    }

    /// Liste condivise per l'area "Condivise": owned .shared + condivise da altri,
    /// dedup per id.
    private var sharedListsForArea: [UserListSummary] {
        let combined = ownedCustomLists.filter { $0.visibility == .shared }
            + viewModel.dashboard.sharedLists
        var seen: Set<String> = []
        return combined.filter { seen.insert($0.id).inserted }
    }

    private var pinnedPublicLists: [UserListSummary] {
        viewModel.dashboard.publicLists.filter(\.isSavedByCurrentUser)
    }

    private var discoverablePublicLists: [UserListSummary] {
        viewModel.dashboard.publicLists.filter { !$0.isSavedByCurrentUser }
    }

    /// "Da vedere" declutterato: solo titoli non ancora iniziati (film mai visti +
    /// serie non ancora cominciate). Le serie in corso vivono nella loro scheda
    /// dedicata "In corso" (`inProgressStates`), non qui.
    private var toWatchStates: [TitlePersonalState] {
        viewModel.dashboard.generalWatchlist.filter { $0.isInToWatchQueue && !$0.isInProgressSeries }
    }

    /// Serie in corso, dalla dashboard (TUTTI i titleStates): include sia le serie
    /// in corso "normali" (generalWatchlist=true) sia il rewatch-in-corso
    /// (generalWatchlist=false, ma seriesStatus resta .inProgress).
    private var inProgressStates: [TitlePersonalState] {
        viewModel.dashboard.inProgressSeries
    }

    private var toWatchAreaSectionTitle: String {
        switch toWatchFilter {
        case .toWatch: return "Da vedere"
        case .inProgress: return "In corso"
        case .watched: return "Visti"
        case .all: return "Tutti i titoli"
        }
    }

    private var toWatchAreaSectionSubtitle: String {
        switch toWatchFilter {
        case .toWatch:
            return "Solo i titoli che non hai ancora iniziato: una coda pulita per decidere in fretta cosa guardare."
        case .inProgress:
            return String(localized: "Serie che stai guardando adesso, incluse quelle che stai rivedendo.")
        case .watched:
            return String(localized: "Cronologia di film e serie che hai completato.")
        case .all:
            return String(localized: "Tutto quello che hai salvato, completato o in coda.")
        }
    }

    @ViewBuilder
    private var selectedAreaContent: some View {
        switch viewModel.selectedArea {
        case .home:
            homeAreaContent
        case .toWatch:
            toWatchAreaContent
        case .shared:
            sharedAreaContent
        case .forYou:
            forYouAreaContent
        }
    }

    /// Home = la watchlist. Una schermata sola: le serie aperte in cima, poi
    /// direttamente la griglia con i suoi filtri. Niente scaffali intermedi ne'
    /// card che rimandano altrove per vedere la propria stessa coda (spec
    /// "una schermata sola", 2026-08-04, gia' in produzione sul web).
    private var homeAreaContent: some View {
        VStack(alignment: .leading, spacing: 18) {
            if !isWelcomeDismissed {
                WatchlistWelcomeCard(
                    onDismiss: {
                        welcomeService.dismiss()
                        isWelcomeDismissed = true
                    }
                )
            }

            if !inProgressStates.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 8) {
                        Image(systemName: "play.circle.fill")
                            .font(.title3.weight(.bold))
                            .foregroundStyle(TwoWatchTheme.brandPrimary)
                        Text("Continua")
                            .font(.title3.weight(.bold))
                            .foregroundStyle(TwoWatchTheme.textPrimary)
                        Spacer(minLength: 0)
                    }

                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 10) {
                            ForEach(inProgressStates) { state in
                                WatchlistGridCell(
                                    state: state,
                                    container: container,
                                    session: session,
                                    shell: shell
                                )
                                .frame(width: 104)
                            }
                        }
                    }
                }
            }

            // La coda intera, subito: e' il motivo per cui si apre la watchlist.
            toWatchAreaContent

            Button {
                viewModel.selectedArea = .shared
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: "folder.fill")
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.brandPrimary)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Le tue liste")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(TwoWatchTheme.textPrimary)
                        Text(myListsForHome.count == 1 ? "1 lista" : "\(myListsForHome.count) liste")
                            .font(.caption)
                            .foregroundStyle(TwoWatchTheme.textMuted)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(TwoWatchTheme.textMuted)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
                .background(
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .fill(TwoWatchTheme.panel)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .stroke(TwoWatchTheme.border, lineWidth: 1)
                )
            }
            .buttonStyle(.plain)
        }
    }

    /// Schermata liste. Prima era "Condivise": tre sezioni eterogenee (tue
    /// condivise, salvate, discovery) con bottoni outline accanto ai titoli e
    /// card piene di chip sovrapposte. Ora è una sola lista di gruppi, con la
    /// visibilità leggibile in riga e la discovery relegata a una voce in fondo.
    private var sharedAreaContent: some View {
        // Tre gruppi disgiunti: le mie (qualsiasi visibilità), quelle in cui mi
        // hanno invitato, quelle pubbliche che seguo. `sharedListsForArea`
        // univa le prime due e faceva comparire due volte la stessa lista.
        let owned = ownedCustomLists
        let shared = viewModel.dashboard.sharedLists
        let saved = pinnedPublicLists
        let isEmpty = owned.isEmpty && shared.isEmpty && saved.isEmpty

        return VStack(alignment: .leading, spacing: 22) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Le tue liste")
                    .font(.largeTitle.weight(.black))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                Text("\(owned.count) tue · \(shared.count) condivise · \(saved.count) salvate")
                    .font(.subheadline)
                    .foregroundStyle(TwoWatchTheme.textMuted)
            }

            Button {
                viewModel.prepareCreateList(preset: nil)
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "plus")
                        .font(.subheadline.weight(.bold))
                    Text("Crea una lista")
                        .font(.headline.weight(.bold))
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 13)
                .background(Capsule().fill(TwoWatchTheme.brandPrimary))
                .foregroundStyle(.white)
            }
            .buttonStyle(.plain)

            if !owned.isEmpty {
                watchlistListsGroup(
                    title: String(localized: "Le mie liste"),
                    note: String(localized: "Solo tu decidi chi le vede"),
                    lists: owned,
                    showsOwner: false
                )
            }

            if !shared.isEmpty {
                watchlistListsGroup(
                    title: String(localized: "Condivise con me"),
                    note: String(localized: "Ti hanno invitato: puoi aggiungere titoli"),
                    lists: shared,
                    showsOwner: true
                )
            }

            if !saved.isEmpty {
                watchlistListsGroup(
                    title: String(localized: "Liste salvate"),
                    note: String(localized: "Liste pubbliche che segui"),
                    lists: saved,
                    showsOwner: true
                )
            }

            WatchlistDiscoverListsRow(count: discoverablePublicLists.count) {
                isShowingPublicListsBrowser = true
            }

            if isEmpty {
                EmptyStateView(
                    title: "Non hai ancora liste",
                    message: "Creane una per organizzare i titoli: una maratona, una serata con qualcuno, un tema.",
                    systemImage: "folder.badge.plus"
                )
            }
        }
    }

    @ViewBuilder
    private func watchlistListsGroup(
        title: String,
        note: String,
        lists: [UserListSummary],
        showsOwner: Bool
    ) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text(title)
                    .font(.title3.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                Spacer(minLength: 8)
                Text("\(lists.count)")
                    .font(.caption)
                    .foregroundStyle(TwoWatchTheme.textMuted)
            }
            Text(note)
                .font(.caption)
                .foregroundStyle(TwoWatchTheme.textMuted)

            LazyVGrid(
                columns: [GridItem(.flexible(), spacing: 10),
                          GridItem(.flexible(), spacing: 10),
                          GridItem(.flexible(), spacing: 10)],
                alignment: .leading,
                spacing: 16
            ) {
                ForEach(lists) { list in
                    WatchlistListGridCard(list: list, showsOwner: showsOwner) { openList(list) }
                }
            }
        }
    }

    private var forYouAreaContent: some View {
        VStack(alignment: .leading, spacing: 16) {
            WatchlistSectionHeader(
                title: "Per te",
                subtitle: String(localized: "Scorciatoie smart per scegliere in fretta cosa vedere.")
            )

            WatchlistDiscoverForYouCard(
                container: container,
                session: session,
                shell: shell
            )

            WatchlistQuickIdeasSection(
                onPickQuickIdea: { idea in activeQuickIdea = idea }
            )

            if !toWatchStates.isEmpty {
                WatchlistSectionHeader(
                    title: String(localized: "Idee dalla tua lista"),
                    subtitle: String(localized: "Titoli salvati che potrebbero fare al caso tuo stasera.")
                )
                LazyVStack(spacing: 12) {
                    ForEach(toWatchStates.prefix(6)) { state in
                        WatchlistCompactToWatchRow(
                            state: state,
                            container: container,
                            session: session,
                            shell: shell,
                            genreLookup: viewModel.genreLookup
                        )
                    }
                }
            }
        }
    }

    private var featuredSharedLists: [UserListSummary] {
        let primary = viewModel.dashboard.sharedLists
        let fallback = pinnedPublicLists
        let combined = primary + fallback
        return Array(combined.prefix(3))
    }

    private func quickIdeaStates(for idea: WatchlistQuickIdeaKind) -> [TitlePersonalState] {
        let pool = viewModel.dashboard.generalWatchlist.filter { $0.isInToWatchQueue }
        switch idea {
        case .underTwoHours:
            // Movies < 120 min, OR series whose total runtime fits in ~2h.
            return pool.filter { state in
                guard let title = state.title else { return false }
                switch state.mediaType {
                case .movie:
                    if let dur = title.metadata.durationMovie, dur > 0 {
                        return dur <= 120
                    }
                    return false
                case .tv:
                    let perEp = title.metadata.durationEpisode ?? 0
                    let totalEpisodes = state.seriesProgress?.totalEpisodeCount
                        ?? title.metadata.episodesPerSeason
                        ?? 0
                    if perEp > 0, totalEpisodes > 0 {
                        return perEp * totalEpisodes <= 120
                    }
                    return false
                }
            }
        case .fromCircle:
            // Titoli salvati che compaiono nelle liste condivise con te / amici.
            let sharedTitleIDs: Set<String> = Set(
                viewModel.dashboard.sharedLists
                    .flatMap { $0.previewTitles.map(\.id) }
            )
            let inSharedLists = pool.filter { sharedTitleIDs.contains($0.titleId) }
            if !inSharedLists.isEmpty { return inSharedLists }
            // Fallback: titoli con community rating significativo (proxy "consigliati").
            return pool.filter { ($0.title?.ratingCount ?? 0) >= 5 }
                .sorted { ($0.title?.ratingAvg ?? 0) > ($1.title?.ratingAvg ?? 0) }
        case .watchTogether:
            // Movies that work for serata insieme: durata ragionevole + community vote alto.
            return pool.filter { state in
                guard let title = state.title else { return false }
                let goodRating = title.ratingAvg >= 7.0
                switch state.mediaType {
                case .movie:
                    let dur = title.metadata.durationMovie ?? 0
                    return dur > 0 && dur <= 150 && goodRating
                case .tv:
                    return goodRating
                }
            }
            .sorted { ($0.title?.ratingAvg ?? 0) > ($1.title?.ratingAvg ?? 0) }
        }
    }

    private var toResumeStates: [TitlePersonalState] {
        viewModel.dashboard.toResume
    }

    private var watchedStates: [TitlePersonalState] {
        viewModel.dashboard.generalWatchlist.filter(\.isCompleted)
    }

    private var allTrackedStates: [TitlePersonalState] {
        viewModel.dashboard.generalWatchlist
    }

    /// Pool dopo filtro per scheda + ordinamento, PRIMA del filtro piattaforma.
    private var sortedToWatchStates: [TitlePersonalState] {
        let pool: [TitlePersonalState]
        switch toWatchFilter {
        case .toWatch: pool = toWatchStates
        case .inProgress: pool = inProgressStates
        case .watched: pool = watchedStates
        case .all: pool = allTrackedStates
        }

        return pool.sorted { lhs, rhs in
            switch toWatchSort {
            case .recentlyAdded:
                let lhsDate = lhs.createdAt ?? lhs.updatedAt ?? lhs.lastInteractionAt ?? .distantPast
                let rhsDate = rhs.createdAt ?? rhs.updatedAt ?? rhs.lastInteractionAt ?? .distantPast
                if lhsDate != rhsDate { return lhsDate > rhsDate }
                return (lhs.title?.name ?? "").localizedCaseInsensitiveCompare(rhs.title?.name ?? "") == .orderedAscending
            case .title:
                let lhsName = lhs.title?.name ?? lhs.titleId
                let rhsName = rhs.title?.name ?? rhs.titleId
                return lhsName.localizedCaseInsensitiveCompare(rhsName) == .orderedAscending
            case .year:
                let lhsYear = lhs.title?.year ?? 0
                let rhsYear = rhs.title?.year ?? 0
                if lhsYear != rhsYear { return lhsYear > rhsYear }
                return (lhs.title?.name ?? "").localizedCaseInsensitiveCompare(rhs.title?.name ?? "") == .orderedAscending
            }
        }
    }

    /// Lista piatta finale: applica anche il filtro per piattaforma (chip), se attivo.
    private var filteredToWatchStates: [TitlePersonalState] {
        guard let platform = toWatchPlatform else { return sortedToWatchStates }
        return sortedToWatchStates.filter { platforms(for: $0).contains(platform) }
    }

    /// Nomi piattaforma per uno stato (denormalizzati sul titolo + eventuale enrichment on-demand).
    private func platforms(for state: TitlePersonalState) -> [String] {
        let fromTitle = state.title?.watchProviderNames ?? []
        if !fromTitle.isEmpty { return fromTitle }
        return viewModel.watchProviderNamesByTitle[state.titleId] ?? []
    }

    /// Mappa name→logoUrl unita su tutti i titoli caricati della watchlist (più
    /// titoli caricati = più copertura). Copertura graduale: nomi senza logo
    /// denormalizzato semplicemente non hanno una entry (i chip/badge fanno
    /// fallback al solo testo). `name` è testo libero dal backend → merge con
    /// `uniquingKeysWith`, mai `uniqueKeysWithValues`.
    private var providerLogos: [String: URL] {
        viewModel.dashboard.generalWatchlist.reduce(into: [String: URL]()) { acc, state in
            guard let logos = state.title?.watchProviderLogos, !logos.isEmpty else { return }
            acc.merge(logos, uniquingKeysWith: { first, _ in first })
        }
    }

    /// Piattaforme disponibili nel pool corrente, ordinate per frequenza (poi A-Z).
    private var availablePlatforms: [String] {
        var counts: [String: Int] = [:]
        for state in sortedToWatchStates {
            for name in platforms(for: state) {
                counts[name, default: 0] += 1
            }
        }
        return counts.keys.sorted { lhs, rhs in
            let cl = counts[lhs] ?? 0
            let cr = counts[rhs] ?? 0
            if cl != cr { return cl > cr }
            return lhs.localizedCaseInsensitiveCompare(rhs) == .orderedAscending
        }
    }

    /// Stati raggruppati per piattaforma: una sezione per piattaforma singola,
    /// String(localized: "Su più piattaforme") per i titoli con ≥2, String(localized: "Non in streaming") per i titoli senza.
    private var platformGroups: [WatchlistPlatformGroup] {
        var single: [String: [TitlePersonalState]] = [:]
        var multi: [TitlePersonalState] = []
        var none: [TitlePersonalState] = []

        for state in sortedToWatchStates {
            let names = platforms(for: state)
            switch names.count {
            case 0: none.append(state)
            case 1: single[names[0], default: []].append(state)
            default: multi.append(state)
            }
        }

        var groups: [WatchlistPlatformGroup] = single
            .map { WatchlistPlatformGroup(id: "platform-\($0.key)", title: $0.key, states: $0.value) }
            .sorted { lhs, rhs in
                if lhs.states.count != rhs.states.count { return lhs.states.count > rhs.states.count }
                return lhs.title.localizedCaseInsensitiveCompare(rhs.title) == .orderedAscending
            }

        if !multi.isEmpty {
            groups.append(WatchlistPlatformGroup(id: "platform-multi", title: String(localized: "Su più piattaforme"), states: multi))
        }
        if !none.isEmpty {
            groups.append(WatchlistPlatformGroup(id: "platform-none", title: String(localized: "Non in streaming"), states: none))
        }
        return groups
    }

    private var toWatchAreaContent: some View {
        VStack(alignment: .leading, spacing: 16) {
            if !toResumeStates.isEmpty {
                WatchlistSectionHeader(
                    title: "Da riprendere",
                    subtitle: String(localized: "Serie che hai messo in pari con nuove stagioni rilasciate dopo. I minuti già visti restano congelati finché non riprendi.")
                )

                LazyVStack(spacing: 12) {
                    ForEach(toResumeStates) { state in
                        WatchlistResumeCard(
                            state: state,
                            container: container,
                            session: session,
                            shell: shell
                        )
                    }
                }
            }

            WatchlistSectionHeader(
                title: toWatchAreaSectionTitle,
                subtitle: toWatchAreaSectionSubtitle
            )

            WatchlistToWatchFilterBar(
                selectedFilter: $toWatchFilter,
                counts: filterCounts
            )

            let platforms = availablePlatforms
            if !platforms.isEmpty, !groupByPlatform {
                Text("Dove in streaming")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(TwoWatchTheme.textMuted)
                    .accessibilityHidden(true)

                WatchlistPlatformFilterBar(
                    platforms: platforms,
                    logos: providerLogos,
                    selection: $toWatchPlatform
                )
            }

            WatchlistToWatchToolbar(
                sort: $toWatchSort,
                layout: $toWatchLayout,
                groupByPlatform: $groupByPlatform,
                canGroupByPlatform: !platforms.isEmpty,
                visibleCount: groupByPlatform ? sortedToWatchStates.count : filteredToWatchStates.count
            )

            toWatchAreaList
        }
        .onChange(of: toWatchPlatform) { _, newValue in
            // Se la piattaforma selezionata sparisce dal pool, torna a "Tutte".
            if let newValue, !availablePlatforms.contains(newValue) {
                toWatchPlatform = nil
            }
        }
        .task(id: sortedToWatchStates.count) {
            // Prima le uscite: è una manciata di query, mentre i provider sono
            // fino a 24 fetch e farebbero aspettare il badge senza motivo.
            await viewModel.loadUpcomingReleases(for: sortedToWatchStates)
            await viewModel.enrichWatchProviders(for: sortedToWatchStates)
        }
    }

    @ViewBuilder
    private var toWatchAreaList: some View {
        if groupByPlatform {
            let groups = platformGroups
            if groups.isEmpty {
                WatchlistToWatchEmptyState(
                    filter: toWatchFilter,
                    onExploreTitles: { shell.presentSearch() }
                )
            } else {
                LazyVStack(alignment: .leading, spacing: 22) {
                    ForEach(groups) { group in
                        VStack(alignment: .leading, spacing: 12) {
                            WatchlistPlatformGroupHeader(
                                title: group.title,
                                count: group.states.count,
                                logoURL: (group.id == "platform-multi" || group.id == "platform-none") ? nil : providerLogos[group.title]
                            )
                            // Nel gruppo "singola piattaforma" l'header lo rende già ovvio: badge ridondante.
                            // String(localized: "Su più piattaforme") invece beneficia ancora del badge (mostra quali).
                            statesList(group.states, showPlatformBadge: group.id == "platform-multi")
                        }
                    }
                }
            }
        } else {
            let states = filteredToWatchStates
            if states.isEmpty {
                WatchlistToWatchEmptyState(
                    filter: toWatchFilter,
                    onExploreTitles: { shell.presentSearch() }
                )
            } else {
                statesList(states, showPlatformBadge: true)
            }
        }
    }

    /// Quanti titoli mostrare prima di "Vedi tutti": 4 righe da 3.
    private static let queuePreviewLimit = 12

    @ViewBuilder
    private func statesList(_ allStates: [TitlePersonalState], showPlatformBadge: Bool) -> some View {
        let isCapped = !showsAllQueue && allStates.count > Self.queuePreviewLimit
        let states = isCapped ? Array(allStates.prefix(Self.queuePreviewLimit)) : allStates

        if toWatchLayout == .grid {
            LazyVGrid(
                columns: [
                    GridItem(.flexible(), spacing: 12, alignment: .top),
                    GridItem(.flexible(), spacing: 12, alignment: .top),
                    GridItem(.flexible(), spacing: 12, alignment: .top)
                ],
                spacing: 14
            ) {
                ForEach(states) { state in
                    WatchlistGridCell(
                        state: state,
                        container: container,
                        session: session,
                        shell: shell,
                        platformNames: platforms(for: state),
                        platformLogos: providerLogos,
                        showPlatformBadge: showPlatformBadge,
                        upcomingReleaseAt: viewModel.upcomingReleaseDate(for: state)
                    )
                    .contextMenu {
                        stateContextMenu(for: state)
                    }
                }
            }
        } else {
            LazyVStack(spacing: 16) {
                ForEach(states) { state in
                    WatchlistStateCard(
                        state: state,
                        container: container,
                        session: session,
                        shell: shell,
                        viewModel: viewModel,
                        onToggleWatchlist: { toggleGeneralWatchlist(state) },
                        onMarkSeen: { markSeen(state) },
                        onAddToList: { queueQuickAdd(state.title) },
                        platformNames: platforms(for: state),
                        platformLogos: providerLogos,
                        showPlatformBadge: showPlatformBadge,
                        upcomingReleaseAt: viewModel.upcomingReleaseDate(for: state)
                    )
                    .contextMenu {
                        stateContextMenu(for: state)
                    }
                }
            }
        }

        if isCapped {
            Button {
                withAnimation(.easeOut(duration: 0.2)) { showsAllQueue = true }
            } label: {
                HStack(spacing: 6) {
                    Text("Vedi tutti")
                        .font(.subheadline.weight(.bold))
                    Text("\(allStates.count)")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(TwoWatchTheme.textMuted)
                    Image(systemName: "chevron.down")
                        .font(.caption.weight(.bold))
                }
                .foregroundStyle(TwoWatchTheme.brandPrimary)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
                .background(
                    RoundedRectangle(cornerRadius: 999, style: .continuous)
                        .fill(TwoWatchTheme.panel)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 999, style: .continuous)
                        .stroke(TwoWatchTheme.border, lineWidth: 1)
                )
            }
            .buttonStyle(.plain)
            .padding(.top, 4)
        }
    }

    private var filterCounts: [WatchlistToWatchFilter: Int] {
        [
            .toWatch: toWatchStates.count,
            .inProgress: inProgressStates.count,
            .watched: watchedStates.count,
            .all: allTrackedStates.count
        ]
    }

    @ViewBuilder
    private func stateContextMenu(for state: TitlePersonalState) -> some View {
        if !state.isCompleted {
            Button {
                markSeen(state)
            } label: {
                Label("Segna come visto", systemImage: "checkmark.circle.fill")
            }
        }

        Button {
            queueQuickAdd(state.title)
        } label: {
            Label("Aggiungi a una lista", systemImage: "rectangle.stack.badge.plus")
        }

        if state.isCompleted, !state.rewatchIntent {
            Button {
                guard let uid = session.firebaseUser?.uid else { return }
                Task { await viewModel.setRewatchIntent(userID: uid, state: state, isIncluded: true) }
            } label: {
                Label("Aggiungi a Rewatch", systemImage: "arrow.counterclockwise.circle.fill")
            }
        }

        if state.generalWatchlist {
            Button(role: .destructive) {
                toggleGeneralWatchlist(state)
            } label: {
                Label("Rimuovi dalla watchlist", systemImage: "bookmark.slash.fill")
            }
        }
    }

    private func openList(_ list: UserListSummary) {
        guard let uid = session.firebaseUser?.uid else { return }
        Task { await viewModel.openList(userID: uid, listID: list.id) }
    }

    /// Identity for the deep-link consume task: cambia all'arrivo di un nuovo
    /// slug E al cambio di sessione (login), così il `.task(id:)` ri-parte.
    private var pendingPublicListConsumeKey: String {
        "\(shell.pendingPublicListSlug ?? "")|\(session.firebaseUser?.uid ?? "")"
    }

    /// Resolves a pending `/lista/{slug}` deep link (set by `AppShellStore`)
    /// once the user is signed in, opening the list detail sheet.
    @MainActor
    private func consumePendingPublicListSlug() async {
        guard let slug = shell.pendingPublicListSlug,
              let uid = session.firebaseUser?.uid else { return }
        shell.pendingPublicListSlug = nil
        await viewModel.openPublicList(slug: slug, userID: uid)
    }

    private func togglePublicListPin(_ list: UserListSummary) {
        guard let uid = session.firebaseUser?.uid else { return }
        Task { await viewModel.togglePublicListPin(userID: uid, list: list) }
    }

    private func toggleGeneralWatchlist(_ state: TitlePersonalState) {
        guard let uid = session.firebaseUser?.uid else { return }
        Task { await viewModel.toggleGeneralWatchlist(userID: uid, state: state) }
    }

    private func removeFromRewatch(_ state: TitlePersonalState) {
        guard let uid = session.firebaseUser?.uid else { return }
        Task { await viewModel.setRewatchIntent(userID: uid, state: state, isIncluded: false) }
    }

    private func markSeen(_ state: TitlePersonalState) {
        guard let uid = session.firebaseUser?.uid else { return }
        Task { await viewModel.markSeen(userID: uid, state: state) }
    }

    private func queueQuickAdd(_ title: Title?) {
        guard title != nil else { return }
        pendingQuickAddTitle = title
    }
}

// MARK: - Filter / sort / layout toolbar

#if DEBUG
private struct WatchlistViewRuntimePreview: View {
    let session: SessionStore
    let viewModel: WatchlistViewModel
    @State private var shell = TwoWatchPreview.shell(selectedTab: .watchlist)

    var body: some View {
        TabView(selection: $shell.selectedTab) {
            Color.clear
                .tabItem {
                    Label("Home", systemImage: "house.fill")
                }
                .tag(AppTab.home)

            Color.clear
                .tabItem {
                    Label("Community", systemImage: "person.2.fill")
                }
                .tag(AppTab.community)

            NavigationStack {
                WatchlistView(
                    container: TwoWatchPreview.container,
                    session: session,
                    shell: shell,
                    previewViewModel: viewModel
                )
            }
            .brandChromePill(shell: shell)
            .tabItem {
                Label("Watchlist", systemImage: "bookmark.fill")
            }
            .tag(AppTab.watchlist)

            Color.clear
                .tabItem {
                    Label("Quiz", systemImage: "questionmark.circle.fill")
                }
                .tag(AppTab.quiz)

            Color.clear
                .tabItem {
                    Label("Profilo", systemImage: "person.crop.circle.fill")
                }
                .tag(AppTab.profile)
        }
        .toolbarBackground(.visible, for: .tabBar)
        .toolbarBackground(TwoWatchTheme.tabMaterial, for: .tabBar)
        .toolbarColorScheme(.dark, for: .tabBar)
    }
}

#Preview("Watchlist", traits: .fixedLayout(width: 393, height: 852)) {
    WatchlistViewRuntimePreview(
        session: TwoWatchPreview.session(),
        viewModel: TwoWatchPreview.watchlistViewModel()
    )
}
#endif
