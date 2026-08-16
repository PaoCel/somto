@preconcurrency import FirebaseFirestore
import SwiftUI

struct RootView: View {
    @Environment(AppContainer.self) private var container
    @Environment(SessionStore.self) private var session
    @Environment(AppShellStore.self) private var shell
    @Environment(\.scenePhase) private var scenePhase
    @State private var requiredAppUpdate: RequiredAppUpdate?
    @State private var recommendedAppUpdate: RecommendedAppUpdate?
    private let appUpdatePolicyStore = AppUpdatePolicyStore()

    var body: some View {
        @Bindable var shell = shell

        ZStack {
            TwoWatchBackground()
            AppTabShellView(container: container, session: session, shell: shell)
                .opacity(session.isLoading ? 0 : 1)
                .allowsHitTesting(!session.isLoading)

            if session.isLoading {
                AnimatedLoadingSplashView()
                    .transition(.opacity)
            }

            // Autenticati su Firebase ma senza profilo: prima l'app mostrava la
            // shell vuota e il profilo diceva "accedi", senza uscita se non
            // riavviare. Ora e' uno stato dichiarato e recuperabile.
            if session.profileLoadFailed && !session.isLoading {
                profileRecoveryScreen
                    .transition(.opacity)
                    .zIndex(80)
            }
        }
        .animation(.easeInOut(duration: 0.28), value: session.isLoading)
        .overlay {
            if shell.isMenuPresented {
                SideMenuDrawer(
                    onDismiss: { shell.dismissMenu() }
                ) {
                    NavigationStack {
                        AppMenuView(container: container, session: session, shell: shell)
                    }
                }
                .transition(.move(edge: .leading).combined(with: .opacity))
                .zIndex(50)
            }
        }
        .animation(.spring(response: 0.36, dampingFraction: 0.86), value: shell.isMenuPresented)
        .sheet(isPresented: $shell.isSearchPresented) {
            NavigationStack {
                SearchView(container: container, session: session, shell: shell)
            }
            .presentationDetents([.large])
            .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: authPresentationBinding) {
            NavigationStack {
                AuthView(container: container, shell: shell, showsCloseButton: !requiresAuthentication)
            }
            .presentationDetents([.large])
            .presentationDragIndicator(.visible)
            .interactiveDismissDisabled(requiresAuthentication)
        }
        .fullScreenCover(isPresented: communitySafetyGateBinding) {
            CommunitySafetyAcceptanceGateView(container: container, session: session)
                .interactiveDismissDisabled(true)
        }
        .fullScreenCover(isPresented: onboardingGateBinding) {
            OnboardingFlowView(container: container, session: session, shell: shell)
                .interactiveDismissDisabled(true)
        }
        .onChange(of: onboardingGateBinding.wrappedValue) { wasPresented, isPresented in
            // A onboarding chiuso l'utente atterra in Home: punto d'ingresso
            // del pre-prompt push one-time. L'import, se c'era, è già partito
            // dentro il flusso (import-first, docs/ONBOARDING_V2.md).
            guard wasPresented, !isPresented else { return }
            offerPushPromptIfNeeded(after: 400_000_000)
        }
        .sheet(item: $shell.activePostCommentsPresentation) { presentation in
            NavigationStack {
                PostCommentsSheetView(
                    container: container,
                    session: session,
                    shell: shell,
                    postID: presentation.postID,
                    focusesComposerOnAppear: presentation.focusesComposer
                )
            }
            .presentationDetents([.large])
            .presentationDragIndicator(.visible)
            .presentationBackground(.clear)
        }
        .fullScreenCover(item: $shell.activePresentedDestination) { destination in
            presentedDestinationView(destination)
        }
        .sheet(item: $shell.activePresentedSheet) { destination in
            presentedSheetView(destination)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $shell.isRatingPromptPresented) {
            RatingPromptSheet(service: container.ratingPromptService)
        }
        .sheet(isPresented: $shell.isPushPromptPresented) {
            PushPermissionPromptSheet(
                onEnable: {
                    container.pushPromptService.markPromptSeen()
                    let granted = await container.pushNotifications.requestAuthorizationFromUser()
                    container.analytics.log(AnalyticsEvent.pushPromptEnabled, [
                        "source": shell.pushPromptTrigger?.rawValue ?? "unknown",
                        "granted": granted
                    ])
                },
                onDismiss: {
                    container.pushPromptService.markPromptSeen()
                    container.analytics.log(AnalyticsEvent.pushPromptDismissed, [
                        "source": shell.pushPromptTrigger?.rawValue ?? "unknown"
                    ])
                }
            )
            .onAppear {
                container.analytics.log(AnalyticsEvent.pushPromptShown, [
                    "source": shell.pushPromptTrigger?.rawValue ?? "unknown"
                ])
            }
        }
        .fullScreenCover(item: $requiredAppUpdate) { requirement in
            RequiredAppUpdateView(requirement: requirement)
                .interactiveDismissDisabled(true)
        }
        // Aggiornamento consigliato: schermata dedicata NON bloccante. Mostrata
        // solo quando non c'è un blocco hard (requiredAppUpdate == nil) e finché
        // l'utente non fa "Più tardi" per quel build (persistito). "Aggiorna ora"
        // apre l'App Store; "Più tardi" chiude e non ripresenta lo stesso build.
        .fullScreenCover(item: $recommendedAppUpdate) { recommendation in
            RecommendedAppUpdateView(
                recommendation: recommendation,
                onDismiss: {
                    appUpdatePolicyStore.markRecommendedDismissed(build: recommendation.recommendedBuild)
                    recommendedAppUpdate = nil
                }
            )
        }
        .task {
            await refreshAppUpdateRequirement()
        }
        .task(id: session.firebaseUser?.uid) {
            await container.pushNotifications.handleAuthenticationChange(to: session.firebaseUser?.uid)
        }
        .task(id: session.isLoading) {
            await container.pushNotifications.routePendingDestinationIfPossible()
        }
        .onChange(of: scenePhase) { _, newPhase in
            guard newPhase == .active else { return }
            Task {
                await refreshAppUpdateRequirement()
                await container.pushNotifications.handleAppBecomingActive(currentUserID: session.firebaseUser?.uid)
                if let uid = session.firebaseUser?.uid {
                    var notifications: [AppNotification]?
                    do { notifications = try await container.notificationRepository.fetchNotifications(userID: uid) } catch { SilentFailure.record(error, context: "Root.notificationBadge") }
                    shell.notificationUnreadCount = notifications?.filter { !$0.read }.count ?? 0
                    shell.threadUnreadCount = await container.threadsRepository.fetchInboxUnreadCount(currentUserID: uid)
                }
            }
        }
        .alert(
            "Sessione",
            isPresented: Binding(
                get: { session.errorMessage != nil },
                set: { _ in session.errorMessage = nil }
            )
        ) {
            Button("Chiudi", role: .cancel) {}
        } message: {
            Text(session.errorMessage ?? "Errore non disponibile")
        }
        .modifier(EpisodeSeenPresenterModifier(
            container: container,
            session: session,
            shell: shell
        ))
    }

    private func refreshAppUpdateRequirement() async {
        let policy = await appUpdatePolicyStore.evaluate()
        requiredAppUpdate = policy.required
        // Un blocco hard ha precedenza: non impilare la schermata soft sopra.
        recommendedAppUpdate = policy.required == nil ? policy.recommended : nil
    }

    /// Propone il pre-prompt push one-time dopo che l'utente atterra in Home
    /// a fine onboarding/tour. Verifica il gate locale (`PushPromptService`,
    /// mai mostrato prima) E lo stato di sistema reale (solo `.notDetermined`
    /// — se l'utente ha già authorized/denied/provisional/ephemeral il
    /// pre-prompt Somto non ha nulla da aggiungere). Il piccolo delay evita
    /// di accavallare la sheet con l'animazione di chiusura del cover.
    private func offerPushPromptIfNeeded(after nanoseconds: UInt64) {
        guard !shell.isPushPromptPresented else { return }
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: nanoseconds)
            // A fine onboarding l'utente atterra sui commenti di un titolo
            // (docs/ONBOARDING_V2.md): non gli sbattiamo un prompt sopra. Il
            // permesso push resta offerto dal banner in Home e a fine import.
            guard shell.activePresentedDestination == nil else { return }
            guard !container.pushPromptService.hasSeenPrompt else { return }
            let status = await container.pushNotifications.currentAuthorizationStatus()
            guard container.pushPromptService.shouldOfferPrompt(currentStatus: status) else { return }
            shell.presentPushPrompt(trigger: .postOnboarding)
        }
    }

    /// Schermata di recupero per il profilo non caricato.
    ///
    /// Non rimanda al login: le credenziali Firebase sono valide, e' il
    /// documento profilo che non e' arrivato. Rifare il login non
    /// risolverebbe, e su un errore di rete sarebbe anche irritante.
    private var profileRecoveryScreen: some View {
        ZStack {
            TwoWatchBackground().ignoresSafeArea()

            VStack(spacing: 18) {
                Image(systemName: "person.crop.circle.badge.exclamationmark")
                    .font(.system(size: 44, weight: .semibold))
                    .foregroundStyle(TwoWatchTheme.textSecondary)

                VStack(spacing: 8) {
                    Text("Non riesco a caricare il tuo profilo")
                        .font(.headline)
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                    Text("L'accesso è riuscito, ma i dati del profilo non sono arrivati. Riprova: se il problema resta, esci e rientra.")
                        .font(.subheadline)
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                        .multilineTextAlignment(.center)
                }
                .padding(.horizontal, 8)

                VStack(spacing: 10) {
                    Button {
                        Task { await session.retryProfileLoad() }
                    } label: {
                        Text("Riprova")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(PrimaryButtonStyle())

                    Button {
                        Task {
                            do {
                                try await container.signOutEverywhere()
                            } catch {
                                // Se il sign-out fallisce l'utente resta dentro
                                // senza saperlo. Vedi docs/PENDING.md.
                                SilentFailure.record(error, context: "Root.signOut")
                            }
                        }
                    } label: {
                        Text("Esci dall'account")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(TwoWatchTheme.textSecondary)
                    .padding(.vertical, 10)
                }
            }
            .padding(28)
            .somtoCard()
            .padding(.horizontal, 28)
        }
    }

    private var requiresAuthentication: Bool {
        !session.isLoading && !session.isAuthenticated
    }

    private var authPresentationBinding: Binding<Bool> {
        Binding(
            get: { shell.isAuthPresented || requiresAuthentication },
            set: { newValue in
                guard !requiresAuthentication else { return }
                shell.isAuthPresented = newValue
            }
        )
    }

    private var communitySafetyGateBinding: Binding<Bool> {
        Binding(
            get: { session.requiresCommunitySafetyAcceptance },
            set: { _ in }
        )
    }

    private var onboardingGateBinding: Binding<Bool> {
        Binding(
            get: { session.requiresOnboarding },
            set: { _ in }
        )
    }

    @ViewBuilder
    private func presentedSheetView(_ destination: AppPresentedDestination) -> some View {
        switch destination {
        case .threads:
            NavigationStack {
                ThreadsListView(container: container, session: session, shell: shell)
                    .toolbar {
                        ToolbarItem(placement: .topBarLeading) {
                            Button("Chiudi") {
                                shell.activePresentedSheet = nil
                            }
                            .foregroundStyle(TwoWatchTheme.textPrimary)
                        }
                    }
            }
        case .widgetGuide:
            WidgetGuideSheet { shell.activePresentedSheet = nil }
        case let .thread(id):
            NavigationStack {
                ThreadDetailView(container: container, session: session, shell: shell, threadID: id)
                    .toolbar {
                        ToolbarItem(placement: .topBarLeading) {
                            Button("Chiudi") {
                                shell.activePresentedSheet = nil
                            }
                            .foregroundStyle(TwoWatchTheme.textPrimary)
                        }
                    }
            }
        default:
            EmptyView()
        }
    }

    @ViewBuilder
    private func presentedDestinationView(_ destination: AppPresentedDestination) -> some View {
        switch destination {
        case .threads, .thread, .widgetGuide:
            // Threads, Thread Detail e la guida al widget sono sheet
            // (`activePresentedSheet`). If they end up here we ignore.
            EmptyView()
        case .profileInbox:
            NavigationStack {
                ProfileInboxView(container: container, session: session, shell: shell)
                    .toolbar {
                        ToolbarItem(placement: .topBarLeading) {
                            modalDismissButton
                        }
                    }
            }
        case let .profile(uid):
            NavigationStack {
                UserProfileDetailView(container: container, session: session, shell: shell, userID: uid)
                    .toolbar {
                        ToolbarItem(placement: .topBarLeading) {
                            modalDismissButton
                        }
                    }
            }
        case let .title(id, focus):
            NavigationStack {
                TitleDetailView(container: container, session: session, shell: shell, titleID: id, initialFocus: focus)
                    .toolbar {
                        ToolbarItem(placement: .topBarLeading) {
                            modalDismissButton
                        }
                    }
            }
        case let .titlesImport(importId):
            NavigationStack {
                TitlesImportView(
                    container: container,
                    session: session,
                    shell: shell,
                    initialImportID: importId
                )
            }
        case let .web(url):
            InAppSafariView(url: url)
                .ignoresSafeArea()
        }
    }

    private var modalDismissButton: some View {
        Button {
            shell.activePresentedDestination = nil
        } label: {
            Image(systemName: "xmark.circle.fill")
                .font(.title3)
                .foregroundStyle(TwoWatchTheme.textSecondary)
        }
        // Area tocco ≥44pt
        .frame(minWidth: 44, minHeight: 44)
        .contentShape(Rectangle())
        .accessibilityLabel("Chiudi")
    }
}

private struct RequiredAppUpdate: Identifiable, Equatable {
    let minBuild: Int
    let latestBuild: Int?
    let title: String
    let message: String
    let appStoreURL: URL

    var id: Int { minBuild }
}

private struct RecommendedAppUpdate: Identifiable, Equatable {
    let recommendedBuild: Int
    let title: String
    let message: String
    let appStoreURL: URL

    var id: Int { recommendedBuild }
}

private struct AppUpdatePolicyStore {
    /// Chiave UserDefaults: build consigliato per cui l'utente ha già premuto
    /// "Più tardi". Se >= recommendedBuild corrente, la schermata soft è muta.
    private let fallbackAppStoreURL = URL(string: "https://apps.apple.com/it/app/somto/id6760966564")!

    /// Valuta in una sola read sia il blocco hard (`minBuild`) sia il prompt
    /// soft non bloccante (`recommendedBuild`). Il soft è soppresso se c'è un
    /// blocco hard attivo o se l'utente lo ha già rimandato per quel build.
    func evaluate() async -> (required: RequiredAppUpdate?, recommended: RecommendedAppUpdate?) {
        let ios: [String: Any]
        do {
            let snapshot = try await Firestore.firestore()
                .collection("experiments")
                .document("global")
                .getDocument()
            guard let data = snapshot.data() else { return (nil, nil) }
            let root = data["appUpdate"] as? [String: Any] ?? data
            ios = root["ios"] as? [String: Any] ?? root
        } catch {
            return (nil, nil)
        }

        let appStoreURL = stringValue(ios["appStoreURL"] ?? ios["url"])
            .flatMap(URL.init(string:)) ?? fallbackAppStoreURL

        let minBuild = intValue(ios["minBuild"] ?? ios["minimumBuild"] ?? ios["iosMinimumBuild"])
        let required: RequiredAppUpdate?
        if let minBuild, minBuild > currentBuildNumber {
            required = RequiredAppUpdate(
                minBuild: minBuild,
                latestBuild: intValue(ios["latestBuild"]),
                title: stringValue(ios["title"]) ?? "Aggiorna Somto",
                message: stringValue(ios["message"]) ?? String(localized: "Questa versione non è più compatibile con alcune funzioni. Aggiorna dall'App Store per continuare."),
                appStoreURL: appStoreURL
            )
        } else {
            required = nil
        }

        // Il soft-update non si valuta se c'è già un blocco hard.
        var recommended: RecommendedAppUpdate?
        let recommendedBuild = intValue(ios["recommendedBuild"] ?? ios["latestBuild"])
        if required == nil,
           let recommendedBuild,
           recommendedBuild > currentBuildNumber,
           recommendedBuild > dismissedRecommendedBuild {
            recommended = RecommendedAppUpdate(
                recommendedBuild: recommendedBuild,
                title: stringValue(ios["recommendedTitle"]) ?? "Nuova versione disponibile",
                message: stringValue(ios["recommendedMessage"]) ?? String(localized: "È disponibile una nuova versione di Somto con miglioramenti e novità. Aggiorna quando vuoi dall'App Store."),
                appStoreURL: appStoreURL
            )
        }

        return (required, recommended)
    }

    func markRecommendedDismissed(build: Int) {
        UserDefaults.standard.set(build, forKey: SomtoDefaultsKey.recommendedUpdateDismissedBuild)
    }

    private var dismissedRecommendedBuild: Int {
        UserDefaults.standard.integer(forKey: SomtoDefaultsKey.recommendedUpdateDismissedBuild)
    }

    private var currentBuildNumber: Int {
        intValue(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion")) ?? 0
    }

    private func intValue(_ value: Any?) -> Int? {
        if let value = value as? Int { return value }
        if let value = value as? NSNumber { return value.intValue }
        if let value = value as? String { return Int(value.trimmingCharacters(in: .whitespacesAndNewlines)) }
        return nil
    }

    private func stringValue(_ value: Any?) -> String? {
        if value == nil || value is NSNull { return nil }
        let raw = String(describing: value ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return raw.isEmpty ? nil : raw
    }
}

private struct RequiredAppUpdateView: View {
    let requirement: RequiredAppUpdate
    @Environment(\.openURL) private var openURL

    var body: some View {
        ZStack {
            TwoWatchBackground()
                .ignoresSafeArea()

            VStack(spacing: 22) {
                Spacer(minLength: 20)

                Image(systemName: "arrow.down.app.fill")
                    .font(.system(size: 54, weight: .bold))
                    .foregroundStyle(TwoWatchTheme.brandGradient)

                VStack(spacing: 10) {
                    Text(requirement.title)
                        .font(.title.weight(.black))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                        .multilineTextAlignment(.center)

                    Text(requirement.message)
                        .font(.body)
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                        .multilineTextAlignment(.center)
                        .lineSpacing(2)
                }

                Button {
                    openURL(requirement.appStoreURL)
                } label: {
                    Label("Apri App Store", systemImage: "arrow.up.forward.app.fill")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(PrimaryButtonStyle())

                Text("Build minimo richiesto: \(requirement.minBuild)")
                    .font(.caption)
                    .foregroundStyle(TwoWatchTheme.textMuted)

                Spacer(minLength: 20)
            }
            .padding(24)
        }
    }
}

/// Schermata dedicata di aggiornamento CONSIGLIATO (non bloccante). A differenza
/// di `RequiredAppUpdateView` offre "Più tardi": l'utente può continuare a usare
/// l'app e il prompt non ritorna per lo stesso build (persistito in UserDefaults).
private struct RecommendedAppUpdateView: View {
    let recommendation: RecommendedAppUpdate
    let onDismiss: () -> Void
    @Environment(\.openURL) private var openURL

    var body: some View {
        ZStack {
            TwoWatchBackground()
                .ignoresSafeArea()

            VStack(spacing: 22) {
                Spacer(minLength: 20)

                Image(systemName: "sparkles.rectangle.stack.fill")
                    .font(.system(size: 54, weight: .bold))
                    .foregroundStyle(TwoWatchTheme.brandGradient)

                VStack(spacing: 10) {
                    Text(recommendation.title)
                        .font(.title.weight(.black))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                        .multilineTextAlignment(.center)

                    Text(recommendation.message)
                        .font(.body)
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                        .multilineTextAlignment(.center)
                        .lineSpacing(2)
                }

                VStack(spacing: 12) {
                    Button {
                        openURL(recommendation.appStoreURL)
                        onDismiss()
                    } label: {
                        Label("Aggiorna ora", systemImage: "arrow.up.forward.app.fill")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(PrimaryButtonStyle())

                    Button("Più tardi") {
                        onDismiss()
                    }
                    .font(.body.weight(.semibold))
                    .foregroundStyle(TwoWatchTheme.textSecondary)
                    .frame(maxWidth: .infinity, minHeight: 44)
                }

                Spacer(minLength: 20)
            }
            .padding(24)
        }
    }
}

private struct CommunitySafetyAcceptanceGateView: View {
    let container: AppContainer
    let session: SessionStore

    @State private var isAccepting = false
    @State private var isSigningOut = false
    @State private var errorMessage: String?

    var body: some View {
        ZStack {
            TwoWatchBackground()

            ScrollView(showsIndicators: false) {
                VStack(spacing: 20) {
                    GlassCard {
                        VStack(alignment: .leading, spacing: 16) {
                            Label("Accetta i termini community per continuare", systemImage: "checkmark.shield.fill")
                                .font(.title3.weight(.black))
                                .foregroundStyle(TwoWatchTheme.textPrimary)

                            Text("Da ora i nuovi utenti accettano i termini community in registrazione. Gli account già esistenti devono confermarli al primo accesso utile prima di continuare a usare Somto.")
                                .font(.subheadline)
                                .foregroundStyle(TwoWatchTheme.textSecondary)

                            VStack(alignment: .leading, spacing: 8) {
                                safetyPoint("Tolleranza zero verso contenuti offensivi, spam e utenti abusivi.")
                                safetyPoint("Chat e thread hanno filtro contenuti, segnalazione rapida e blocco utenti.")
                                safetyPoint("Le segnalazioni vengono prese in carico dal team entro 24 ore.")
                            }

                            HStack(spacing: 12) {
                                Link("Termini di servizio", destination: CommunitySafetyPolicy.termsURL)
                                    .buttonStyle(.bordered)
                                    .tint(TwoWatchTheme.textSecondary)

                                Link("Supporto e moderazione", destination: CommunitySafetyPolicy.supportURL)
                                    .buttonStyle(.bordered)
                                    .tint(TwoWatchTheme.textSecondary)
                            }

                            if let errorMessage, !errorMessage.isEmpty {
                                Text(errorMessage)
                                    .font(.subheadline.weight(.medium))
                                    .foregroundStyle(TwoWatchTheme.warning)
                            }

                            Button {
                                Task { await acceptTerms() }
                            } label: {
                                if isAccepting {
                                    ProgressView()
                                        .tint(.white)
                                        .frame(maxWidth: .infinity)
                                } else {
                                    Text("Accetta e continua")
                                        .frame(maxWidth: .infinity)
                                }
                            }
                            .buttonStyle(PrimaryButtonStyle())
                            .disabled(isAccepting || isSigningOut)

                            Button {
                                Task { await signOut() }
                            } label: {
                                if isSigningOut {
                                    ProgressView()
                                        .frame(maxWidth: .infinity)
                                } else {
                                    Text("Esci")
                                        .frame(maxWidth: .infinity)
                                }
                            }
                            .buttonStyle(.bordered)
                            .tint(TwoWatchTheme.textSecondary)
                            .disabled(isAccepting || isSigningOut)
                        }
                    }
                }
                .padding(20)
                .padding(.top, 48)
            }
        }
    }

    private func acceptTerms() async {
        guard let userID = session.firebaseUser?.uid else { return }

        isAccepting = true
        errorMessage = nil
        defer { isAccepting = false }

        do {
            try await container.userRepository.acceptCommunitySafetyTerms(userID: userID)
            await session.refreshProfile()
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }

    private func signOut() async {
        isSigningOut = true
        errorMessage = nil
        defer { isSigningOut = false }

        do {
            try await container.signOutEverywhere()
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }

    private func safetyPoint(_ text: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "checkmark.circle.fill")
                .font(.footnote.weight(.bold))
                .foregroundStyle(TwoWatchTheme.success)
                .padding(.top, 2)

            Text(text)
                .font(.subheadline)
                .foregroundStyle(TwoWatchTheme.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// Applica `tabBarMinimizeBehavior` dove esiste, senza toccare nulla altrove.
/// Isolato in un modifier perché `if #available` non si può mettere in mezzo a
/// una catena di modificatori su `TabView`.
private struct MinimizingTabBarModifier: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.tabBarMinimizeBehavior(.onScrollDown)
        } else {
            content
        }
    }
}

struct AppTabShellView: View {
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore

    var body: some View {
        @Bindable var shell = shell
        let chromeVisible = !session.isLoading

        TabView(selection: $shell.selectedTab) {
            NavigationStack {
                HomeView(container: container, session: session, shell: shell)
            }
            .brandChromePill(shell: shell, isVisible: chromeVisible)
            .tabItem {
                Label("Home", systemImage: "house.fill")
            }
            .tag(AppTab.home)

            NavigationStack {
                CommunityView(container: container, session: session, shell: shell)
            }
            .brandChromePill(shell: shell, isVisible: chromeVisible)
            .tabItem {
                Label("Community", systemImage: "person.2.fill")
            }
            .tag(AppTab.community)

            NavigationStack {
                WatchlistView(container: container, session: session, shell: shell)
            }
            .brandChromePill(shell: shell, isVisible: chromeVisible)
            .tabItem {
                Label("Watchlist", systemImage: "bookmark.fill")
            }
            .tag(AppTab.watchlist)

            NavigationStack {
                QuizHomeView(container: container, session: session, shell: shell)
            }
            .brandChromePill(shell: shell, isVisible: chromeVisible)
            .tabItem {
                Label("Quiz", systemImage: "questionmark.circle.fill")
            }
            .tag(AppTab.quiz)

            NavigationStack {
                ProfileView(container: container, session: session, shell: shell)
            }
            .brandChromePill(shell: shell, isVisible: chromeVisible)
            .tabItem {
                Label("Profilo", systemImage: "person.crop.circle.fill")
            }
            .tag(AppTab.profile)
        }
        .toolbarBackground(.visible, for: .tabBar)
        .toolbarBackground(TwoWatchTheme.tabMaterial, for: .tabBar)
        .toolbarColorScheme(.dark, for: .tabBar)
        // Tab bar che si compatta scorrendo verso il basso e torna piena
        // risalendo: comportamento di sistema, quindi gesture, safe area e
        // accessibilità restano quelle native. Su iOS 17/18 non esiste
        // l'equivalente e la tab bar resta piena (nessuna regressione).
        .modifier(MinimizingTabBarModifier())
        .sheet(isPresented: $shell.isNotificationsPresented) {
            NavigationStack {
                NotificationsView(container: container, session: session, shell: shell)
                    .toolbar {
                        ToolbarItem(placement: .topBarLeading) {
                            Button("Chiudi") {
                                shell.dismissNotifications()
                            }
                            .foregroundStyle(TwoWatchTheme.textPrimary)
                        }
                    }
            }
            .presentationDetents([.large])
            .presentationDragIndicator(.visible)
        }
    }
}
