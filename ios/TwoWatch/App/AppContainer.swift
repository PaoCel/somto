import Observation

@Observable
@MainActor
final class AppContainer {
    let authRepository: AuthenticationRepository
    let userRepository: UserRepository
    let titleRepository: TitleRepository
    let watchlistRepository: WatchlistRepository
    let notificationRepository: NotificationRepository
    let homeRepository: HomeRepository
    let threadsRepository: ThreadsRepository
    let matchRepository: MatchRepository
    let postsRepository: PostsRepository
    let socialInboxRepository: SocialInboxRepository
    let quizRepository: QuizRepository
    let titlesImportRepository: TitlesImportRepository
    let sessionStore: SessionStore
    let shellStore: AppShellStore
    let pushNotifications: PushNotificationsCoordinator
    let ratingPromptService: RatingPromptService
    let pushPromptService: PushPromptService
    let importRevealStore: ImportRevealStore
    let episodeSeenCoordinator: EpisodeSeenCoordinator
    let titleFollowStore: TitleFollowStore
    let spotlightIndexer: SpotlightIndexer
    let analytics: AnalyticsLogging

    init(
        startSessionObservation: Bool = true,
        analytics: AnalyticsLogging = FirebaseAnalyticsLogger()
    ) {
        FirebaseBootstrap.configureIfNeeded()

        // Prima di qualsiasi lettura: i flag locali vivono sui device degli
        // utenti con i nomi vecchi, e vanno portati sui nomi canonici senza
        // perderne il valore (docs/context/IOS_CODE_STYLE.md §3).
        SomtoDefaultsMigration.run()

        // Il keychain sopravvive alla disinstallazione dell'app, `UserDefaults`
        // no: se il marcatore non c'e' siamo alla prima apertura dopo
        // un'installazione pulita, e un token del widget rimasto li' dal
        // proprietario precedente del telefono sarebbe un credenziale valido
        // che nessuno ha piu' chiesto. Si butta prima di ogni altra cosa.
        WidgetAuthStore.clearIfFreshInstall()

        self.analytics = analytics
        authRepository = AuthenticationRepository()
        userRepository = UserRepository()
        titleRepository = TitleRepository()
        watchlistRepository = WatchlistRepository(
            titleRepository: titleRepository,
            userRepository: userRepository
        )
        notificationRepository = NotificationRepository(userRepository: userRepository)
        homeRepository = HomeRepository(
            titleRepository: titleRepository,
            userRepository: userRepository,
            watchlistRepository: watchlistRepository
        )
        threadsRepository = ThreadsRepository(titleRepository: titleRepository, userRepository: userRepository)
        threadsRepository.analytics = analytics
        matchRepository = MatchRepository()
        postsRepository = PostsRepository(titleRepository: titleRepository, userRepository: userRepository)
        socialInboxRepository = SocialInboxRepository(userRepository: userRepository, titleRepository: titleRepository)
        titlesImportRepository = TitlesImportRepository()
        sessionStore = SessionStore(
            authRepository: authRepository,
            userRepository: userRepository,
            shouldObserveAuthState: startSessionObservation
        )
        sessionStore.watchlistRepository = watchlistRepository
        // L'indice di sistema sopravvive all'app: al cambio account va svuotato
        // anche quando l'uscita non passa da `signOutEverywhere` (sessione
        // scaduta, account cancellato). Il posto che vede *tutti* i cambi di
        // stato auth e' `SessionStore`, dove gia' si azzerano le altre cache.
        spotlightIndexer = SpotlightIndexer()
        sessionStore.spotlightIndexer = spotlightIndexer
        shellStore = AppShellStore()
        let quiz = QuizRepository()
        quiz.session = sessionStore
        quizRepository = quiz
        pushNotifications = PushNotificationsCoordinator(
            notificationRepository: notificationRepository,
            analytics: analytics
        )
        ratingPromptService = RatingPromptService()
        pushPromptService = PushPromptService()
        importRevealStore = ImportRevealStore()
        episodeSeenCoordinator = EpisodeSeenCoordinator()
        // Condiviso, non uno per schermata: il feed e il dettaglio post
        // mostrano lo stesso bottone sugli stessi titoli, e devono dire la
        // stessa cosa senza rileggere.
        titleFollowStore = TitleFollowStore(titleRepository: titleRepository)

        // Le sonde sui fallback dei mapper riportano qui. Iniettato invece che
        // importato dentro `TitleParsing` per non legare i parser puri a
        // Firebase: restano testabili senza SDK.
        let analyticsForProbe = analytics
        FallbackProbe.reporter = { key in
            analyticsForProbe.log(AnalyticsEvent.legacyShapeSeen, ["shape": key])
        }
    }

    /// Unico punto di uscita dall'account.
    ///
    /// Esiste perche' il sign-out non e' solo `auth.signOut()`: il token push
    /// va sganciato PRIMA, mentre si e' ancora proprietari del documento
    /// (`users/{uid}/notificationTokens` e' protetto da `isOwner`). Fatto dopo,
    /// e' sempre negato dalle rules, e il vecchio account continua a ricevere
    /// notifiche su un dispositivo che ormai usa qualcun altro.
    ///
    /// I tre call site che chiamavano `authRepository.signOut()` diretto ora
    /// passano di qui: se la sequenza cambia, cambia in un posto solo.
    ///
    /// L'indice Spotlight si svuota **prima** del sign-out, non dopo: e' una
    /// scrittura di sistema che non dipende dall'auth, e farla qui la rende
    /// deterministica invece di affidarla soltanto al listener di
    /// `SessionStore`. Quello resta come rete per le uscite che non passano di
    /// qui (sessione scaduta, account cancellato).
    /// Stessa ragione per il riassunto del widget "Watchlist": vive in un App
    /// Group, cioe' l'unico posto dove dei dati personali sopravvivono fuori dal
    /// sandbox dell'app. Chi entra dopo sullo stesso telefono non deve trovare
    /// in schermata Home la watchlist di prima.
    func signOutEverywhere() async throws {
        await pushNotifications.detachTokenBeforeSignOut()
        await spotlightIndexer.clear()
        WatchlistWidgetSnapshotStore.clear()
        // Il token del widget PRIMA del sign-out, come il token push: dopo,
        // resterebbe nel keychain un credenziale valido di un account da cui
        // l'utente e' appena uscito.
        WidgetAuthStore.clear()
        try authRepository.signOut()
    }

}
