@preconcurrency import FirebaseFirestore
import Observation
import SwiftUI
import UIKit

/// View model della **Home launchpad**. Il feed sociale e il composer sono
/// migrati nella tab Community; qui restano le sezioni di scoperta personale
/// (Tendenze, Novità). Lo Step 3 arricchisce il launchpad con hero + continua
/// a guardare + novità per te.
/// View model della **Home launchpad**. Il feed sociale e il composer sono
/// migrati nella tab Community; qui restano le superfici di scoperta personale:
/// hero "Cosa vuoi guardare oggi?", "Continua a guardare", "Novità per te" e le
/// righe di catalogo Tendenze/Novità.
@Observable
@MainActor
final class HomeViewModel {
    private let homeRepository: HomeRepository
    @ObservationIgnored private var loadedKey: String?

    var hero: [TitlePersonalState] = []
    var continueWatching: [TitlePersonalState] = []
    var newForYou: [TitlePersonalState] = []
    var providerLane: HomeRepository.ProviderLane?
    var upcomingReleases: [HomeRepository.UpcomingRelease] = []
    var trending: [Title] = []
    var fresh: [Title] = []
    var isLoading = false
    var errorMessage: String?

    init(homeRepository: HomeRepository) {
        self.homeRepository = homeRepository
    }

    func load(userID: String?) async {
        let key = userID ?? "guest"
        guard loadedKey != key else { return }
        await reload(userID: userID)
    }

    func reload(userID: String?) async {
        loadedKey = userID ?? "guest"
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        do {
            async let trendingTask = homeRepository.fetchTrendingTitles()
            async let freshTask = homeRepository.fetchFreshTitles()
            // La corsia editoriale arriva da un feed pubblico separato: se e'
            // temporaneamente indisponibile non deve oscurare tutta la Home.
            async let upcomingTask = (try? await homeRepository.fetchUpcomingReleases()) ?? []

            if let userID {
                async let launchpadTask = homeRepository.fetchLaunchpad(userID: userID)
                async let providerTask = homeRepository.fetchProviderLane()
                let (trendingTitles, freshTitles, upcoming, launchpad, provider) = try await (
                    trendingTask,
                    freshTask,
                    upcomingTask,
                    launchpadTask,
                    providerTask
                )
                trending = trendingTitles
                fresh = freshTitles
                upcomingReleases = upcoming
                hero = launchpad.hero
                continueWatching = launchpad.continueWatching
                newForYou = launchpad.newForYou
                providerLane = provider
                updateWatchlistWidget()
            } else {
                let (trendingTitles, freshTitles, upcoming) = try await (trendingTask, freshTask, upcomingTask)
                trending = trendingTitles
                fresh = freshTitles
                upcomingReleases = upcoming
                hero = []
                continueWatching = []
                newForYou = []
                providerLane = nil
            }
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }

    /// Lascia al widget le serie in corso appena caricate.
    ///
    /// PERCHE' ANCHE QUI, e non solo nella Watchlist — il riassunto lo scriveva
    /// solo quella tab, quindi chi apriva l'app e restava in Home continuava a
    /// vedere il widget fermo su "apri Somto". Succedeva davvero (2026-08-14, sul
    /// device). `continueWatching` e' gia' in mano alla Home: scriverlo da qui
    /// non costa una lettura in piu'.
    ///
    /// Le voci "da guardare" non le tocca — se le e' gia' scritte la Watchlist,
    /// restano (vedi `snapshot(fromHome:)`).
    private func updateWatchlistWidget() {
        let series = continueWatching
        Task.detached(priority: .utility) {
            WatchlistWidgetSnapshotStore.write(
                WatchlistWidgetSnapshotBuilder.snapshot(fromHome: series)
            )
        }
    }
}

struct HomeView: View {
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore
    private let disablesAutomaticLoading: Bool
    @State private var viewModel: HomeViewModel
    /// `@AppStorage`, non `@State` inizializzato da `UserDefaults`: quello era
    /// uno snapshot congelato al primo init della View, che non si sarebbe mai
    /// accorto di una scrittura fatta altrove (docs/context/IOS_CODE_STYLE.md §3.3).
    @AppStorage(SomtoDefaultsKey.youngBannerDismissed) private var isYoungBannerDismissed = false
    @State private var showsPushBanner = false
    /// Stato dell'import per la Home (docs/ONBOARDING_V2.md, fase 6). Chi
    /// importa esce dal funnel e trova una Home che non gli dice niente
    /// mentre il job macina: e' li' che se ne va.
    @State private var importBanner: HomeImportBanner.State?

    init(container: AppContainer, session: SessionStore, shell: AppShellStore) {
        self.container = container
        self.session = session
        self.shell = shell
        disablesAutomaticLoading = false
        _viewModel = State(initialValue: HomeViewModel(homeRepository: container.homeRepository))
    }

#if DEBUG
    init(
        container: AppContainer,
        session: SessionStore,
        shell: AppShellStore,
        previewViewModel: HomeViewModel,
        previewScrollOffset: CGFloat = 0
    ) {
        self.container = container
        self.session = session
        self.shell = shell
        disablesAutomaticLoading = true
        _viewModel = State(initialValue: previewViewModel)
    }
#endif

    var body: some View {
        ScrollViewReader { scrollProxy in
            ScrollView {
                VStack(spacing: 18) {
                    Color.clear
                        .frame(height: 0)
                        .id("home-top")
                        .background(
                            GeometryReader { proxy in
                                let offset = max(0, -proxy.frame(in: .named("home-scroll")).minY)
                                Color.clear
                                    .preference(key: HomeScrollOffsetPreferenceKey.self, value: offset)
                                    .preference(key: ChromeBarCompactPreferenceKey.self, value: offset > 0)
                                    .preference(key: ChromeBarMinimalPreferenceKey.self, value: offset > 60)
                            }
                        )

                    if !isYoungBannerDismissed {
                        HomeYoungProjectBanner(
                            onContactSupport: {
                                // L'account di supporto (admin) non ha un thread
                                // "support_{uid}" verso se stesso: il server salta
                                // utente==supporto. Per gli admin apriamo la lista
                                // messaggi (dove il supporto risponde), non un self-thread.
                                if session.permissions.canRunAdminTools {
                                    shell.presentThreads()
                                } else if let uid = session.firebaseUser?.uid ?? session.appUser?.id {
                                    shell.activePresentedSheet = .thread(id: "support_\(uid)")
                                } else {
                                    shell.activePresentedDestination = .web(CommunitySafetyPolicy.supportURL)
                                }
                            },
                            onDismiss: {
                                withAnimation(.easeOut(duration: 0.2)) {
                                    isYoungBannerDismissed = true
                                }
                            }
                        )
                        .padding(.horizontal, 14)
                        .transition(.move(edge: .top).combined(with: .opacity))
                    }

                    if let importBanner {
                        HomeImportBanner(
                            state: importBanner,
                            onOpen: {
                                if case let .running(job) = importBanner {
                                    shell.activePresentedDestination = .titlesImport(importId: job.id)
                                } else {
                                    shell.selectedTab = .profile
                                }
                            },
                            onDismiss: {
                                if case let .completed(job, _) = importBanner {
                                    container.importRevealStore.markRevealSeen(importID: job.id)
                                }
                                withAnimation(.easeOut(duration: 0.2)) {
                                    self.importBanner = nil
                                }
                            }
                        )
                        .padding(.horizontal, 14)
                        .transition(.move(edge: .top).combined(with: .opacity))
                    }

                    if showsPushBanner {
                        HomePushPermissionBanner(
                            onActivate: {
                                Task {
                                    let granted = await container.pushNotifications.requestAuthorizationFromUser()
                                    if granted {
                                        // Il pre-prompt one-shot (onboarding/import) non deve
                                        // ripresentarsi altrove: l'utente ha già deciso qui.
                                        container.pushPromptService.markPromptSeen()
                                    }
                                    withAnimation(.easeOut(duration: 0.2)) {
                                        showsPushBanner = false
                                    }
                                }
                            },
                            onDismiss: {
                                withAnimation(.easeOut(duration: 0.2)) {
                                    showsPushBanner = false
                                }
                                container.pushPromptService.markHomeBannerDismissed()
                            }
                        )
                        .padding(.horizontal, 14)
                        .transition(.move(edge: .top).combined(with: .opacity))
                    }

                    HomeNetflixImportPost {
                        shell.activePresentedDestination = .titlesImport(importId: nil)
                    }
                    .padding(.horizontal, 14)

                    if viewModel.isLoading {
                        ProgressView()
                            .tint(TwoWatchTheme.brandPrimary)
                            .padding(.top, 24)
                    } else {
                        launchpadContent
                    }
                }
                .padding(.top, 48)
                .padding(.bottom, 16)
                .simultaneousGesture(TapGesture().onEnded {
                    dismissKeyboard()
                })
            }
            .background(TwoWatchBackground())
            .coordinateSpace(name: "home-scroll")
            .scrollIndicators(.hidden)
            .scrollDismissesKeyboard(.interactively)
            .toolbar(.hidden, for: .navigationBar)
            .task(id: session.firebaseUser?.uid) {
                guard !disablesAutomaticLoading else { return }
                await viewModel.load(userID: session.firebaseUser?.uid)
            }
            .task(id: session.firebaseUser?.uid) {
                guard !disablesAutomaticLoading else { return }
                await refreshPushBannerVisibility()
            await refreshImportBanner()
            }
            .refreshable {
                guard !disablesAutomaticLoading else { return }
                await viewModel.reload(userID: session.firebaseUser?.uid)
            }
            .onChange(of: shell.homeRefreshToken) {
                guard !disablesAutomaticLoading else { return }
                withAnimation(.easeInOut(duration: 0.3)) {
                    scrollProxy.scrollTo("home-top", anchor: .top)
                }
                Task { await viewModel.reload(userID: session.firebaseUser?.uid) }
            }
        }
    }

    /// Ricalcola la visibilità del banner "Attiva le notifiche": solo utenti
    /// autenticati, solo se il permesso di sistema è ancora `.notDetermined`
    /// e se il TTL di 14 giorni dall'ultimo dismiss è scaduto (o non c'è mai
    /// stato un dismiss). Richiamata al caricamento della Home.
    private func refreshPushBannerVisibility() async {
        guard session.isAuthenticated else {
            showsPushBanner = false
            return
        }
        let status = await container.pushNotifications.currentAuthorizationStatus()
        showsPushBanner = container.pushPromptService.shouldOfferHomeBanner(currentStatus: status)
    }

    /// Legge lo stato import per la Home: prima un job in corso, altrimenti
    /// il reveal una-tantum di uno appena finito. Mai entrambi. Fallisce in
    /// silenzio: e' una cortesia, non un contenuto della schermata.
    private func refreshImportBanner() async {
        guard let uid = session.firebaseUser?.uid else {
            importBanner = nil
            return
        }
        let repo = container.titlesImportRepository

        var active: TitlesImportJob?
        do { active = try await repo.fetchActiveImport(userID: uid) } catch { SilentFailure.record(error, context: "Home.activeImport") }
        if let active, ["queued", "matching", "uploading"].contains(active.status) {
            importBanner = .running(active)
            return
        }

        // `try?` appiattisce già l'opzionale del return: `done` è concreto.
        var done: TitlesImportJob?
        do { done = try await repo.fetchLastCompletedImport(userID: uid) } catch { SilentFailure.record(error, context: "Home.lastCompletedImport") }
        guard let done,
              done.matchedCount > 0,
              !container.importRevealStore.hasSeenReveal(importID: done.id)
        else {
            importBanner = nil
            return
        }
        importBanner = .completed(done, done.matchedCount)
    }

    /// True quando l'utente non ha ancora nulla di personale da mostrare
    /// (watchlist vuota, niente serie in corso, niente novità).
    private var hasNoPersonalContent: Bool {
        viewModel.hero.isEmpty
            && viewModel.continueWatching.isEmpty
            && viewModel.newForYou.isEmpty
    }

    @ViewBuilder
    private var launchpadContent: some View {
        if hasNoPersonalContent {
            EmptyStateView(
                title: "Inizia la tua watchlist",
                message: "Aggiungi film e serie che vuoi vedere: qui ti mostreremo cosa guardare stasera e cosa riprendere.",
                systemImage: "sparkles.tv",
                actionTitle: "Esplora titoli"
            ) {
                shell.presentSearch()
            }
            .padding(.top, 12)
            .padding(.horizontal, 14)
        }

        // Hero "Cosa vuoi guardare oggi?" — deck dalla watchlist generale.
        if !viewModel.hero.isEmpty {
            WatchlistTonightHeroSection(
                states: viewModel.hero,
                container: container,
                session: session,
                shell: shell
            )
            .padding(.horizontal, 14)
        }

        // Continua a guardare — serie in corso, riprendi da dove eri.
        if !viewModel.continueWatching.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                HomeSectionHeader(
                    title: "Continua a guardare",
                    subtitle: String(localized: "Riprendi le serie che hai iniziato")
                )
                ScrollView(.horizontal, showsIndicators: false) {
                    LazyHStack(spacing: 12) {
                        ForEach(viewModel.continueWatching) { state in
                            HomeContinueWatchingCard(
                                state: state,
                                container: container,
                                session: session,
                                shell: shell
                            )
                        }
                    }
                    .padding(.horizontal, 2)
                }
            }
            .padding(.horizontal, 14)
        }

        if !viewModel.upcomingReleases.isEmpty {
            HomeUpcomingReleasesSection(
                releases: viewModel.upcomingReleases,
                container: container,
                session: session,
                shell: shell
            )
            .padding(.horizontal, 14)
        }

        // Novità per te — serie finite con nuovi contenuti disponibili.
        if !viewModel.newForYou.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                HomeSectionHeader(
                    title: String(localized: "Novità per te"),
                    subtitle: String(localized: "Nuove stagioni sui titoli che hai già visto")
                )
                LazyVStack(spacing: 12) {
                    ForEach(viewModel.newForYou) { state in
                        WatchlistResumeCard(
                            state: state,
                            container: container,
                            session: session,
                            shell: shell
                        )
                    }
                }
            }
            .padding(.horizontal, 14)
        }

        if let providerLane = viewModel.providerLane {
            HomeDiscoveryRow(
                title: String(
                    format: String(localized: "Potrebbe piacerti su %@"),
                    locale: Locale.current,
                    providerLane.providerName
                ),
                subtitle: String(localized: "In base ai titoli che guardi, non a un abbonamento dichiarato"),
                titles: providerLane.titles,
                container: container,
                session: session,
                shell: shell
            )
            .padding(.horizontal, 14)
        }

        VStack(spacing: 14) {
            HomeDiscoveryRow(
                title: "Tendenze",
                subtitle: String(localized: "I titoli più visti adesso"),
                titles: viewModel.trending,
                container: container,
                session: session,
                shell: shell
            )

            HomeDiscoveryRow(
                title: "Novità",
                subtitle: "Appena aggiunti al catalogo",
                titles: viewModel.fresh,
                container: container,
                session: session,
                shell: shell
            )
        }
        .padding(.horizontal, 14)
    }
}

/// Header di sezione del launchpad Home (su sfondo scuro).
private struct HomeSectionHeader: View {
    let title: String
    let subtitle: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.title3.weight(.bold))
                .foregroundStyle(TwoWatchTheme.textPrimary)
            Text(subtitle)
                .font(.caption)
                .foregroundStyle(TwoWatchTheme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Card compatta "Continua a guardare": poster + nome + punto di ripresa (S·E).
private struct HomeContinueWatchingCard: View {
    let state: TitlePersonalState
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore

    private let posterWidth: CGFloat = 124
    private let posterHeight: CGFloat = 184

    private var resumeLabel: String {
        if let season = state.seriesProgress?.lastWatchedSeasonNumber,
           let episode = state.seriesProgress?.lastWatchedEpisodeNumber {
            return "Sei a S\(season)·E\(episode)"
        }
        if let watched = state.seriesProgress?.episodesWatchedCount,
           let total = state.seriesProgress?.totalEpisodeCount, total > 0 {
            return "\(watched)/\(total) episodi"
        }
        return "In corso"
    }

    var body: some View {
        if let title = state.title {
            NavigationLink {
                TitleDetailView(container: container, session: session, shell: shell, titleID: title.id)
            } label: {
                VStack(alignment: .leading, spacing: 6) {
                    PosterImageView(
                        url: title.posterPath,
                        width: posterWidth,
                        height: posterHeight,
                        cornerRadius: 14
                    )
                    .frame(width: posterWidth, height: posterHeight)
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))

                    Text(title.name)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                        .lineLimit(1)
                        .frame(width: posterWidth, alignment: .leading)

                    Label(resumeLabel, systemImage: "play.circle.fill")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(TwoWatchTheme.brandPrimary)
                        .lineLimit(1)
                        .monospacedDigit()
                        .frame(width: posterWidth, alignment: .leading)
                }
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(title.name), \(resumeLabel)")
            .accessibilityHint("Apri dettaglio titolo")
        }
    }
}

/// Dismissible "progetto giovane" disclaimer at the top of the Home feed —
/// sets expectations that the app is young/growing and points to the
/// existing support flow. Stays hidden after the user dismisses it once.
private struct HomeYoungProjectBanner: View {
    let onContactSupport: () -> Void
    let onDismiss: () -> Void

    // @ScaledMetric size-preserving: default invariato, scala con Dynamic Type.
    @ScaledMetric(relativeTo: .footnote) private var closeIconSize: CGFloat = 13

    var body: some View {
        GlassCard(padding: 14) {
            HStack(alignment: .top, spacing: 10) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Somto è giovane e ambizioso 🚀 Qualcosa può ancora incepparsi: noi sistemiamo in fretta. Scrivici in chat: ti rispondiamo direttamente lì.")
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)

                    Button("Scrivici", action: onContactSupport)
                        .font(.caption.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.brandPrimary)
                        .accessibilityLabel("Apri la chat di supporto per segnalare un problema")
                }

                Spacer(minLength: 0)

                Button(action: onDismiss) {
                    Image(systemName: "xmark")
                        .font(.system(size: closeIconSize, weight: .bold))
                        .foregroundStyle(TwoWatchTheme.textMuted)
                        .frame(width: 28, height: 28)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Chiudi il messaggio")
            }
        }
    }
}

/// Banner "Attiva le notifiche" con dismiss a TTL (14 giorni, non
/// permanente): a differenza del pre-prompt one-shot post-onboarding/import
/// (`PushPromptService.shouldOfferPrompt`, gate `pushPromptSeenV1`), qui
/// vogliamo ripresentarci periodicamente agli utenti esistenti che non
/// hanno mai deciso (`.notDetermined`), finché non attivano le notifiche o
/// il sistema registra una decisione (denied/authorized).
private struct HomePushPermissionBanner: View {
    let onActivate: () -> Void
    let onDismiss: () -> Void

    // @ScaledMetric size-preserving: default invariato, scala con Dynamic Type.
    @ScaledMetric(relativeTo: .footnote) private var closeIconSize: CGFloat = 13

    var body: some View {
        GlassCard(padding: 14) {
            HStack(alignment: .top, spacing: 10) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Attiva le notifiche")
                        .font(.footnote.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)

                    Text("Ricevi risposte, sfide quiz e consigli degli amici appena arrivano.")
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)

                    Button("Attiva", action: onActivate)
                        .font(.caption.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.brandPrimary)
                        .accessibilityLabel("Attiva le notifiche push")
                }

                Spacer(minLength: 0)

                Button(action: onDismiss) {
                    Image(systemName: "xmark")
                        .font(.system(size: closeIconSize, weight: .bold))
                        .foregroundStyle(TwoWatchTheme.textMuted)
                        .frame(width: 28, height: 28)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Chiudi il messaggio")
            }
        }
    }
}

private struct HomeNetflixImportPost: View {
    let onOpenImport: () -> Void

    var body: some View {
        Button(action: onOpenImport) {
            HStack(spacing: 12) {
                Image(systemName: "square.and.arrow.down.fill")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.brandPrimary)
                    .frame(width: 30, height: 30)
                    .background(TwoWatchTheme.panel, in: Circle())

                VStack(alignment: .leading, spacing: 2) {
                    Text("Importa i tuoi dati")
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                    Text("Porta cronologia, voti e watchlist da TV Time o Netflix.")
                        .font(.caption)
                        .foregroundStyle(TwoWatchTheme.textMuted)
                }

                Spacer(minLength: 0)

                Image(systemName: "chevron.right")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.textMuted)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(TwoWatchTheme.panel.opacity(0.72), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(TwoWatchTheme.border, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Importa i tuoi dati da TV Time o Netflix")
    }
}

/// Preference key per l'offset di scroll condiviso da Home e Community
/// (guida la compattazione della chrome bar). `internal` perché usato in
/// entrambi i file.
struct HomeScrollOffsetPreferenceKey: PreferenceKey {
    static let defaultValue: CGFloat = 0

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}

@MainActor
func dismissKeyboard() {
    UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
}

// MARK: - HomeDiscoveryRow

private struct HomeDiscoveryRow: View {
    let title: String
    let subtitle: String
    let titles: [Title]
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore

    private let posterWidth: CGFloat = 124
    private let posterHeight: CGFloat = 184

    var body: some View {
        if titles.isEmpty {
            EmptyView()
        } else {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(title)
                            .font(.title3.weight(.bold))
                            .foregroundStyle(.black)
                        Text(subtitle)
                            .font(.caption)
                            .foregroundStyle(.black.opacity(0.55))
                    }
                    Spacer()
                }

                ScrollView(.horizontal, showsIndicators: false) {
                    LazyHStack(spacing: 12) {
                        ForEach(titles) { title in
                            NavigationLink {
                                TitleDetailView(
                                    container: container,
                                    session: session,
                                    shell: shell,
                                    titleID: title.id
                                )
                            } label: {
                                VStack(alignment: .leading, spacing: 6) {
                                    PosterImageView(
                                        url: title.posterPath,
                                        width: posterWidth,
                                        height: posterHeight,
                                        cornerRadius: 14
                                    )
                                    .frame(width: posterWidth, height: posterHeight)
                                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))

                                    Text(title.name)
                                        .font(.footnote.weight(.semibold))
                                        .foregroundStyle(.black)
                                        .lineLimit(2)
                                        .multilineTextAlignment(.leading)
                                        .frame(width: posterWidth, alignment: .leading)

                                    if !title.subtitle.isEmpty {
                                        Text(title.subtitle)
                                            .font(.caption2)
                                            .foregroundStyle(.black.opacity(0.55))
                                            .lineLimit(1)
                                            .frame(width: posterWidth, alignment: .leading)
                                    }
                                }
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(title.name)
                            .accessibilityHint("Apri dettaglio titolo")
                        }
                    }
                    .padding(.horizontal, 2)
                }
            }
            .padding(14)
            .background(Color.white, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 24, style: .continuous)
                    .stroke(Color.black.opacity(0.06), lineWidth: 1)
            )
        }
    }
}

#if DEBUG
#Preview("Home Feed") {
    HomeViewRuntimePreview(
        session: TwoWatchPreview.session(),
        viewModel: TwoWatchPreview.homeViewModel(),
        previewScrollOffset: 140
    )
}

#Preview("Home Full") {
    HomeViewRuntimePreview(
        session: TwoWatchPreview.session(),
        viewModel: TwoWatchPreview.homeViewModel()
    )
}

#Preview("Home Loading") {
    let viewModel = HomeViewModel(homeRepository: TwoWatchPreview.container.homeRepository)
    viewModel.isLoading = true

    return HomeViewRuntimePreview(
        session: TwoWatchPreview.session(),
        viewModel: viewModel
    )
}

private struct HomeViewRuntimePreview: View {
    let session: SessionStore
    let viewModel: HomeViewModel
    let previewScrollOffset: CGFloat
    @State private var shell = TwoWatchPreview.shell()

    init(
        session: SessionStore,
        viewModel: HomeViewModel,
        previewScrollOffset: CGFloat = 0
    ) {
        self.session = session
        self.viewModel = viewModel
        self.previewScrollOffset = previewScrollOffset
    }

    var body: some View {
        TabView(selection: $shell.selectedTab) {
            NavigationStack {
                HomeView(
                    container: TwoWatchPreview.container,
                    session: session,
                    shell: shell,
                    previewViewModel: viewModel,
                    previewScrollOffset: previewScrollOffset
                )
            }
            .brandChromePill(shell: shell)
            .tabItem {
                Label("Home", systemImage: "house.fill")
            }
            .tag(AppTab.home)

            Color.clear
                .tabItem {
                    Label("Community", systemImage: "person.2.fill")
                }
                .tag(AppTab.community)

            Color.clear
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
#endif
