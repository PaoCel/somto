import SwiftUI

/// Coordinatore dell'onboarding v2 (spec: `docs/ONBOARDING_V2.md`).
///
/// L'onboarding non spiega Somto, lo fa fare. Prima una domanda sola — "hai
/// già una cronologia da portare?" — e se la risposta è sì l'import parte
/// SUBITO: gli step successivi girano mentre il job macina, invece di lasciare
/// l'utente su una Home vuota ad aspettare.
///
/// Step: sorgente → watchlist → libreria. La libreria si salta quando un
/// import è già partito: chiedere "cosa hai visto?" a chi ci ha appena
/// consegnato la sua cronologia è la cosa peggiore che si possa fare.
/// Seguiti e commenti arrivano nelle fasi 3-4.
struct OnboardingFlowView: View {
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore

    private enum Step {
        case source
        case watchlist
        case library
        case follow
    }

    @State private var step: Step = .source
    /// True quando l'utente ha scelto una sorgente e l'import è partito: lo
    /// step libreria non ha più senso, la cronologia sta già arrivando.
    @State private var didStartImport = false
    /// Titoli scelti nello step watchlist: restano i seed del taste profile,
    /// esattamente come faceva il vecchio picker "Cosa hai amato?".
    @State private var watchlistTitleIds: [String] = []
    /// Import nativo presentato come cover sopra l'onboarding. Non passa da
    /// `shell.activePresentedDestination`: quello sostituirebbe il cover
    /// dell'onboarding invece di impilarsi sopra.
    @State private var presentedImportSource: TitlesImportSource?
    /// Letterboxd: l'import nativo iOS non esiste ancora, si passa da
    /// `/import.html` in-app.
    @State private var letterboxdURL: URL?
    @State private var isFinishing = false
    @State private var hasLoggedStart = false
    @State private var errorMessage: String?

    var body: some View {
        ZStack {
            switch step {
            case .source:
                OnboardingSourceView(onChoose: handleSourceChoice)
                    .transition(.opacity)
            case .watchlist:
                OnboardingTitlePickerView(
                    mode: .watchlist,
                    titleRepository: container.titleRepository,
                    onConfirm: confirmWatchlist,
                    onSkip: {} // watchlist non è skippabile
                )
                .id(Step.watchlist)
                .transition(.opacity)
            case .library:
                OnboardingTitlePickerView(
                    mode: .library,
                    titleRepository: container.titleRepository,
                    onConfirm: confirmLibrary,
                    onSkip: { goToFollow() }
                )
                .id(Step.library)
                .transition(.opacity)
            case .follow:
                OnboardingFollowView(
                    container: container,
                    session: session,
                    seedTitleIds: watchlistTitleIds,
                    onContinue: { finish() },
                    onEmpty: { finish() }
                )
                .transition(.opacity)
            }

            if isFinishing {
                Color.black.opacity(0.28)
                    .ignoresSafeArea()
                HStack(spacing: 10) {
                    ProgressView()
                        .tint(.white)
                    Text("Salvo le preferenze…")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.white)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .background(.ultraThinMaterial, in: Capsule())
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Salvataggio onboarding in corso")
            }
        }
        .animation(.easeInOut(duration: 0.3), value: step)
        .preferredColorScheme(.dark)
        .fullScreenCover(item: $presentedImportSource) { source in
            NavigationStack {
                TitlesImportView(
                    container: container,
                    session: session,
                    shell: shell,
                    initialImportID: nil,
                    initialSource: source,
                    // Dentro il cover di onboarding `shell.activePresentedDestination`
                    // non chiude niente: la chiusura (e il passaggio allo step
                    // successivo) passa da qui.
                    onboardingHandoff: { goToWatchlist() }
                )
            }
        }
        .sheet(item: letterboxdPresentation) { presentation in
            InAppSafariView(url: presentation.url)
                .ignoresSafeArea()
                .onDisappear { goToWatchlist() }
        }
        .onAppear {
            guard !hasLoggedStart else { return }
            hasLoggedStart = true
            container.analytics.log(AnalyticsEvent.onboardingStarted)
        }
        .alert("Impossibile completare", isPresented: Binding(
            get: { errorMessage != nil },
            set: { if !$0 { errorMessage = nil } }
        )) {
            Button("Riprova", role: .cancel) {}
        } message: {
            Text(errorMessage ?? "")
        }
    }

    private var letterboxdPresentation: Binding<OnboardingWebPresentation?> {
        Binding(
            get: { letterboxdURL.map(OnboardingWebPresentation.init) },
            set: { letterboxdURL = $0?.url }
        )
    }

    // MARK: - Sorgente

    private func handleSourceChoice(_ choice: OnboardingSourceChoice) {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        container.analytics.log(AnalyticsEvent.onboardingSourceChosen, [
            "source": choice.analyticsValue
        ])
        stampSource(choice)

        switch choice {
        case let .titlesImport(source):
            didStartImport = true
            presentedImportSource = source
        case .letterboxdWeb:
            didStartImport = true
            letterboxdURL = SomtoWebLinks.importURL
        case .fromScratch:
            didStartImport = false
            goToWatchlist()
        }
    }

    /// Scrive la sorgente scelta su `usersPrivate/{uid}.onboardingStatus`.
    /// Fire-and-forget: se fallisce l'utente non se ne accorge e prosegue —
    /// è telemetria di prodotto, non un dato che sblocca qualcosa.
    private func stampSource(_ choice: OnboardingSourceChoice) {
        guard let uid = session.firebaseUser?.uid else { return }
        Task {
            try? await container.userRepository.markOnboardingSource(
                uid: uid,
                source: choice.analyticsValue
            )
        }
    }

    private func goToWatchlist() {
        presentedImportSource = nil
        withAnimation { step = .watchlist }
    }

    // MARK: - Step con write

    /// Step 1: i titoli scelti finiscono davvero in watchlist. Se c'è un
    /// import in corso la libreria arriva da lì e si chiude qui.
    private func confirmWatchlist(_ titleIds: [String]) {
        watchlistTitleIds = titleIds
        runWrites(
            titleIds: titleIds,
            event: AnalyticsEvent.onboardingStepWatchlist,
            write: { uid, titleID in
                _ = try await container.watchlistRepository.toggleWatchlist(
                    userID: uid,
                    titleID: titleID,
                    source: "ios_onboarding"
                )
            },
            then: {
                if didStartImport {
                    goToFollow()
                } else {
                    withAnimation { step = .library }
                }
            }
        )
    }

    private func goToFollow() {
        withAnimation { step = .follow }
    }

    /// Ultimo passo: invece di un quarto step che spiega i commenti, l'utente
    /// atterra sulla scheda VERA di un titolo che ha appena salvato, sulla tab
    /// Community, con i commenti già lì. Se scrive bene, se non scrive ha
    /// comunque visto che esistono — che è lo scopo del passo.
    ///
    /// Il piccolo ritardo lascia chiudere il cover dell'onboarding prima di
    /// presentarne un altro: due `fullScreenCover` nello stesso frame non si
    /// impilano.
    private func landOnComments() {
        guard let titleID = watchlistTitleIds.first else { return }
        container.analytics.log(AnalyticsEvent.onboardingStepComment)
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 250_000_000)
            shell.activePresentedDestination = .title(id: titleID, focus: "community")
        }
    }

    /// Step 2: i titoli scelti finiscono nella libreria del profilo ("Visti").
    private func confirmLibrary(_ titleIds: [String]) {
        runWrites(
            titleIds: titleIds,
            event: AnalyticsEvent.onboardingStepLibrary,
            write: { uid, titleID in
                _ = try await container.watchlistRepository.markTitleCompletedByID(
                    userID: uid,
                    titleID: titleID
                )
            },
            then: { goToFollow() }
        )
    }

    /// Esegue le write di uno step in sequenza, con il pending a schermo.
    ///
    /// Sequenziale e non in parallelo di proposito: `toggleWatchlist` e
    /// `markTitleCompletedByID` toccano lo stesso doc di stats dell'utente, e
    /// tre titoli non giustificano il rischio di contesa. Un errore su un
    /// titolo non blocca gli altri: lo step è un acceleratore, non un
    /// contratto — l'utente può sempre rifare l'azione dalla scheda titolo.
    private func runWrites(
        titleIds: [String],
        event: String,
        write: @escaping (String, String) async throws -> Void,
        then: @escaping () -> Void
    ) {
        guard !isFinishing else { return }
        container.analytics.log(event, ["count": titleIds.count])

        guard let uid = session.firebaseUser?.uid, !titleIds.isEmpty else {
            then()
            return
        }

        isFinishing = true
        Task {
            for titleID in titleIds {
                try? await write(uid, titleID)
            }
            isFinishing = false
            then()
        }
    }

    // MARK: - Chiusura

    /// Persiste l'esito e chiude soltanto dopo conferma: in caso di rete lenta
    /// il pending è visibile e un errore non viene scambiato per successo.
    private func finish() {
        guard !isFinishing else { return }
        isFinishing = true

        let uid = session.firebaseUser?.uid
        let seeds = watchlistTitleIds
        container.analytics.log(AnalyticsEvent.onboardingCompleted, [
            "skipped": seeds.isEmpty,
            "seed_count": seeds.count,
            "with_import": didStartImport
        ])

        Task {
            guard let uid else {
                session.markOnboardingDismissed()
                isFinishing = false
                return
            }
            do {
                if seeds.isEmpty {
                    try await container.userRepository.markOnboardingSkipped(uid: uid)
                } else {
                    try await container.userRepository.completeOnboarding(uid: uid, seedTitleIds: seeds)
                }
                session.markOnboardingDismissed()
                landOnComments()
            } catch {
                errorMessage = UserFacingError.message(for: error)
                isFinishing = false
            }
        }
    }
}

/// Wrapper `Identifiable` per presentare una pagina web come sheet locale
/// (stesso pattern del fallback "Continua dal sito" dell'import).
private struct OnboardingWebPresentation: Identifiable {
    let url: URL
    var id: String { url.absoluteString }
}

#if DEBUG
#Preview {
    OnboardingFlowView(
        container: TwoWatchPreview.container,
        session: TwoWatchPreview.session(),
        shell: TwoWatchPreview.shell()
    )
}
#endif
