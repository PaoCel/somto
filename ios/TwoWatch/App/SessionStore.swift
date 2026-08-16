@preconcurrency import FirebaseAuth
@preconcurrency import FirebaseFirestore
#if !DEBUG
@preconcurrency import FirebaseCrashlytics
#endif
import Observation

@Observable
@MainActor
final class SessionStore {
    private let authRepository: AuthenticationRepository
    private let userRepository: UserRepository
    @ObservationIgnored private var authHandle: AuthStateDidChangeListenerHandle?
    @ObservationIgnored var watchlistRepository: WatchlistRepository?
    /// Indice Spotlight, da svuotare quando cambia l'utente. Iniettato da
    /// `AppContainer` come `watchlistRepository`: `SessionStore` nasce prima
    /// dei servizi che lo usano.
    @ObservationIgnored var spotlightIndexer: SpotlightIndexer?

    /// Di chi e' il riassunto lasciato al widget "Watchlist". Serve solo a
    /// riconoscere il cambio di utente: il contenuto sta nell'App Group, qui
    /// resta l'uid per sapere quando buttarlo.
    ///
    /// PERSISTENTE, e non una proprieta' in memoria: in RAM ripartiva `nil` a
    /// ogni avvio, quindi ogni apertura dell'app sembrava un cambio utente e il
    /// widget si svuotava — poi si ripopolava solo quando la Home finiva di
    /// caricare, e se si entrava dal widget su una scheda titolo poteva non
    /// succedere affatto. E' il "dopo un paio di aperture spariscono i dati"
    /// visto sul device il 2026-08-15.
    @ObservationIgnored private var widgetSnapshotOwner: String? {
        get { UserDefaults.standard.string(forKey: SomtoDefaultsKey.widgetSnapshotOwner) }
        set {
            if let newValue {
                UserDefaults.standard.set(newValue, forKey: SomtoDefaultsKey.widgetSnapshotOwner)
            } else {
                UserDefaults.standard.removeObject(forKey: SomtoDefaultsKey.widgetSnapshotOwner)
            }
        }
    }

    var firebaseUser: User?
    var appUser: AppUser?
    var isLoading: Bool
    var errorMessage: String?
    var needsOnboarding: Bool = false

    /// True quando l'utente e' autenticato su Firebase ma il suo profilo NON
    /// e' stato caricato.
    ///
    /// PERCHE' ESISTE — senza questo flag lo stato era indistinguibile da
    /// "loggato e a posto": `firebaseUser` valorizzato faceva risultare
    /// `isAuthenticated == true`, quindi niente schermata di login, mentre
    /// `appUser == nil` faceva cadere i permessi su `.guest` e svuotava ogni
    /// schermata. L'utente restava "dentro l'app senza essere dentro l'app",
    /// senza via d'uscita se non riavviare. Successo il 2026-08-09 cambiando
    /// account sullo stesso dispositivo.
    private(set) var profileLoadFailed = false

    /// Cache locale `titleId -> isCompleted` per il gate anti-spoiler. Letta
    /// dai componenti rendering (SpoilerGate) per decidere se sbloccare un
    /// contenuto flaggato spoiler. Aggiornata al boot della sessione e dopo
    /// `markTitleCompleted` chiamato dal tap "Ho visto X".
    private(set) var completedTitleIDs: Set<String> = []

    /// Cache locale degli utenti bloccati dal viewer. Letta da feed e
    /// commenti per nascondere SUBITO i contenuti di un bloccato
    /// (Guideline 1.2: il blocco deve rimuovere i contenuti dal feed
    /// all'istante). Aggiornata al boot e da `markUserBlockedLocally`.
    private(set) var blockedUserIDs: Set<String> = []

    init(
        authRepository: AuthenticationRepository,
        userRepository: UserRepository,
        shouldObserveAuthState: Bool = true
    ) {
        self.authRepository = authRepository
        self.userRepository = userRepository
        isLoading = shouldObserveAuthState

        if shouldObserveAuthState {
            observeAuthState()
        }
    }

    var isAuthenticated: Bool {
        firebaseUser != nil || appUser != nil
    }

    var permissions: AppPermissionSet {
        appUser?.permissions ?? .guest
    }

    var requiresCommunitySafetyAcceptance: Bool {
        guard firebaseUser != nil, !isLoading else { return false }
        return appUser?.hasAcceptedCommunitySafetyTerms == false
    }

    /// True quando il nuovo utente deve ancora vedere l'onboarding. Sta dopo il
    /// gate community-safety, così i due full-screen cover non si sovrappongono.
    var requiresOnboarding: Bool {
        guard firebaseUser != nil, !isLoading, !requiresCommunitySafetyAcceptance else { return false }
        return needsOnboarding
    }

    func markOnboardingDismissed() {
        needsOnboarding = false
    }

    /// Ritenta il caricamento del profilo dopo un fallimento, senza costringere
    /// l'utente a rifare il login: le credenziali Firebase sono valide, e' il
    /// profilo che non e' arrivato.
    func retryProfileLoad() async {
        guard let user = firebaseUser else { return }
        await consumeAuthChange(user)
    }

    func refreshProfile() async {
        guard let uid = firebaseUser?.uid else { return }
        do {
            appUser = try await userRepository.fetchUser(uid: uid)
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }

    /// Carica/refresha la cache dei titoli completati dell'utente (usata dal
    /// gate anti-spoiler). Chiamabile al boot e dopo aver marcato un titolo
    /// come visto. Errori loggati ma silenziosi: il gate degrada a "blur".
    func refreshCompletedTitleIDs() async {
        guard let uid = firebaseUser?.uid, let repo = watchlistRepository else { return }
        do {
            completedTitleIDs = try await repo.fetchCompletedTitleIDs(userID: uid)
        } catch {
            // Silenzioso: il gate userà la cache stale (worst case: più blur).
        }
    }

    /// Marca localmente un titolo come completato nella cache di sessione
    /// (chiamato dopo che il tap "Ho visto X" è stato persistito su Firestore).
    func markTitleCompletedLocally(_ titleID: String) {
        let trimmed = titleID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        completedTitleIDs.insert(trimmed)
    }

    /// Carica/refresha la cache degli utenti bloccati (filtro feed/commenti).
    /// Errori silenziosi: worst case il filtro usa la cache stale.
    func refreshBlockedUserIDs() async {
        guard let uid = firebaseUser?.uid else { return }
        do {
            blockedUserIDs = try await userRepository.listBlockedUserIDs(myUid: uid)
        } catch {
            // Silenzioso: il filtro degrada alla cache precedente.
        }
    }

    /// Aggiorna la cache locale dopo un blocco persistito su Firestore:
    /// i contenuti dell'utente spariscono dal feed nello stesso frame.
    func markUserBlockedLocally(_ uid: String) {
        let trimmed = uid.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        blockedUserIDs.insert(trimmed)
    }

    /// Speculare di `markUserBlockedLocally` dopo uno sblocco.
    func markUserUnblockedLocally(_ uid: String) {
        blockedUserIDs.remove(uid.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    private func observeAuthState() {
        authHandle = authRepository.addStateListener { [weak self] user in
            guard let self else { return }
            Task { @MainActor in
                await self.consumeAuthChange(user)
            }
        }
    }


    /// Carica il profilo, ritentando UNA volta se Firestore risponde
    /// `permission-denied` dopo aver forzato il refresh del token.
    ///
    /// PERCHE' — `addStateDidChangeListener` scatta nell'istante in cui cambia
    /// `Auth.currentUser`, ma Firestore aggiorna il proprio token in modo
    /// asincrono. Cambiando account sullo stesso dispositivo, la scrittura di
    /// `users/{nuovoUid}` puo' partire ancora con il token del PRECEDENTE
    /// utente: la rule `uid() == userId` la nega, e l'utente vede
    /// "Missing or insufficient permissions" (successo il 2026-08-09).
    ///
    /// Le LETTURE in quel momento passano — `isSignedIn()` e' comunque vero —
    /// quindi il sintomo e' esattamente una scrittura negata su un profilo
    /// nuovo, non un blocco totale.
    ///
    /// `getIDTokenResult(forcingRefresh:)` forza la propagazione del token
    /// corretto; il secondo tentativo trova le rules soddisfatte. Se invece il
    /// diniego e' reale (rules davvero restrittive), il retry fallisce uguale e
    /// si finisce nella schermata di recupero, che e' il posto giusto.
    private func loadProfileRetryingOnPermissionDenied(for user: User) async throws {
        do {
            try await loadProfile(for: user)
        } catch {
            guard Self.isPermissionDenied(error) else { throw error }
            // Forza la propagazione del token del nuovo utente e riprova.
            do {
                _ = try await user.getIDTokenResult(forcingRefresh: true)
            } catch {
                // Se il refresh del token fallisce, il retry sotto fallira' a
                // sua volta e l'utente finisce nella schermata di recupero.
                SilentFailure.record(error, context: "Session.forceTokenRefresh")
            }
            try await loadProfile(for: user)
        }
    }

    private func loadProfile(for user: User) async throws {
        try await userRepository.ensureUserDocument(for: user, preferredDisplayName: user.displayName)

        // fetchUser e fetchOnboardingNeedsPrompt sono indipendenti tra loro:
        // lanciarle in parallelo accorcia lo splash rispetto a 2 await seriali.
        async let fetchedUser = userRepository.fetchUser(uid: user.uid)
        async let onboardingPrompt = userRepository.fetchOnboardingNeedsPrompt(uid: user.uid)

        appUser = try await fetchedUser
        do { needsOnboarding = try await onboardingPrompt } catch { SilentFailure.record(error, context: "Session.onboardingPrompt"); needsOnboarding = false }
    }

    /// `permission-denied` e' il codice 7 di Firestore (`FirestoreErrorDomain`).
    /// Si controlla il codice e non il messaggio: quello e' localizzato.
    nonisolated static func isPermissionDenied(_ error: Error) -> Bool {
        let nsError = error as NSError
        return nsError.domain == FirestoreErrorDomain
            && nsError.code == FirestoreErrorCode.permissionDenied.rawValue
    }

    private func consumeAuthChange(_ user: User?) async {
        isLoading = true
        firebaseUser = user
        errorMessage = nil

        // Cambio account o logout: i titoli del vecchio utente non devono
        // restare cercabili da Spotlight sul device di chi c'e' adesso. Fuori
        // dal flusso di auth di proposito — e' una scrittura di sistema, non
        // deve allungare lo splash — e non nel `guard` sotto, perche' deve
        // valere anche quando si passa da un account all'altro senza mai
        // vedere `nil`.
        if let spotlightIndexer {
            Task { await spotlightIndexer.handleAuthenticatedUserChange(to: user?.uid) }
        }

        // Stessa storia per il riassunto del widget "Watchlist", con un dettaglio
        // in piu': quello vive in un App Group, fuori dal sandbox dell'app, e
        // resterebbe li' anche dopo il logout. Si azzera a ogni cambio di
        // utente; a chi entra lo riscrive la Watchlist al primo caricamento.
        if widgetSnapshotOwner != user?.uid {
            widgetSnapshotOwner = user?.uid
            WatchlistWidgetSnapshotStore.clear()
            WidgetAuthStore.clear()
        }

        // Il token che permette al bottone "episodio visto" del widget di
        // scrivere. Si riscrive a ogni cambio di sessione, non una volta sola:
        // il refresh token puo' ruotare, e uno vecchio nel keychain vorrebbe
        // dire un bottone che smette di funzionare senza dirlo.
        if let user,
           let refreshToken = user.refreshToken, !refreshToken.isEmpty,
           let config = FirebaseConfig.loadIfPresent() {
            WidgetAuthStore.save(WidgetAuthCredentials(
                uid: user.uid,
                refreshToken: refreshToken,
                apiKey: config.apiKey,
                projectID: config.projectID,
                functionsRegion: config.functionsRegion
            ))
        }

        #if !DEBUG
        Crashlytics.crashlytics().setUserID(user?.uid ?? "")
        #endif

        guard let user else {
            appUser = nil
            needsOnboarding = false
            completedTitleIDs = []
            blockedUserIDs = []
            profileLoadFailed = false
            isLoading = false
            return
        }

        do {
            try await loadProfileRetryingOnPermissionDenied(for: user)
            profileLoadFailed = false
        } catch {
            appUser = nil
            errorMessage = UserFacingError.message(for: error)
            // NON si resta in silenzio con firebaseUser valorizzato: quello e'
            // il limbo. Il flag fa mostrare a RootView una schermata di
            // recupero con "Riprova" ed "Esci".
            profileLoadFailed = true
        }

        // Boot cache anti-spoiler + utenti bloccati in background — non
        // bloccano il flow auth.
        Task { [weak self] in
            await self?.refreshCompletedTitleIDs()
            await self?.refreshBlockedUserIDs()
        }

        isLoading = false
    }
}
