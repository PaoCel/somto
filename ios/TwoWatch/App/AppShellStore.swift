import Foundation
import Observation
import UserNotifications

enum AppTab: Hashable {
    case home
    case community
    case watchlist
    case quiz
    case profile
}

enum AppPresentedDestination: Hashable, Identifiable {
    case threads
    /// Come si usa il widget. Ci si arriva SOLO toccando il widget stesso: e'
    /// li' che nasce la domanda ("e adesso? come cambio la serie?").
    case widgetGuide
    case thread(id: String)
    case profileInbox
    case profile(uid: String)
    case title(id: String, focus: String?)
    case titlesImport(importId: String?)
    case web(URL)

    var id: String {
        switch self {
        case .threads:
            return "threads"
        case .widgetGuide:
            return "widget-guide"
        case let .thread(id):
            return "thread:\(id)"
        case .profileInbox:
            return "profile-inbox"
        case let .profile(uid):
            return "profile:\(uid)"
        case let .title(id, focus):
            return "title:\(id):\(focus ?? "default")"
        case let .titlesImport(importId):
            return "titles-import:\(importId ?? "new")"
        case let .web(url):
            return "web:\(url.absoluteString)"
        }
    }
}

struct PostCommentsPresentation: Identifiable, Hashable {
    let id = UUID()
    let postID: String
    let focusesComposer: Bool
}

@Observable
@MainActor
final class AppShellStore {
    var selectedTab: AppTab = .home
    var isMenuPresented = false
    var isSearchPresented = false
    var isAuthPresented = false
    var isNotificationsPresented = false
    var isRatingPromptPresented = false
    /// True quando il pre-prompt Somto per le notifiche push è presentato
    /// (post-onboarding o post-avvio-import, gate `PushPromptService`). Il
    /// trigger che lo ha aperto è in `pushPromptTrigger`, usato solo per
    /// analytics/logica di dismiss del chiamante.
    var isPushPromptPresented = false
    var pushPromptTrigger: PushPromptService.Trigger?
    var activePostCommentsPresentation: PostCommentsPresentation?
    var activePresentedDestination: AppPresentedDestination?
    /// Destination presented as a sheet (used by Threads / Thread Detail so
    /// the user can swipe down to dismiss, mirroring Notifications UX).
    var activePresentedSheet: AppPresentedDestination?
    var socialRefreshToken = UUID()
    var homeRefreshToken = UUID()
    var notificationUnreadCount: Int = 0 { didSet { syncAppIconBadge() } }
    var threadUnreadCount: Int = 0 { didSet { syncAppIconBadge() } }
    var chromeBarCompact = false
    /// Token from an external quiz-invite deep link, waiting to be claimed.
    /// Survives a sign-up detour; the Quiz home consumes and clears it.
    var pendingQuizInviteToken: String?
    /// Slug from a public-list deep link (`/lista/{slug}`), waiting to be
    /// resolved and opened. Survives a sign-up detour; the Watchlist tab
    /// consumes and clears it.
    var pendingPublicListSlug: String?
    /// Prompt text set by `CommunityDiscussionStarterCard`'s "spunto" chips,
    /// waiting to prefill the post composer (`HomeComposerCard`). Consumed
    /// (set back to `nil`) as soon as the composer applies it — mirrors web's
    /// `composerText.value = prompt` (community.page.js `wireDiscussionStarter`).
    var composerPrefillText: String?

    /// Totale non letti (notifiche + messaggi) mostrato come badge sull'icona app.
    var totalUnreadBadge: Int { max(0, notificationUnreadCount) + max(0, threadUnreadCount) }

    /// Allinea il badge dell'icona app (springboard) al totale non letti.
    /// `setBadgeCount` fallisce silenziosamente se il badge non è autorizzato.
    func syncAppIconBadge() {
        let count = totalUnreadBadge
        Task { try? await UNUserNotificationCenter.current().setBadgeCount(count) }
    }

    func presentThreads() {
        dismissTransientUI()
        activePresentedSheet = .threads
    }

    func presentMenu() {
        isMenuPresented = true
    }

    /// Apre il pre-prompt Somto per le notifiche push. Il chiamante deve aver
    /// già verificato `PushPromptService.shouldOfferPrompt` (mai visto +
    /// authorization ancora `.notDetermined`) prima di chiamarlo.
    func presentPushPrompt(trigger: PushPromptService.Trigger) {
        pushPromptTrigger = trigger
        isPushPromptPresented = true
    }

    func dismissMenu() {
        isMenuPresented = false
    }

    func presentSearch() {
        isSearchPresented = true
    }

    func presentAuth() {
        isAuthPresented = true
    }

    func presentNotifications() {
        isNotificationsPresented = true
    }

    func dismissNotifications() {
        isNotificationsPresented = false
    }

    func presentPostComments(postID: String, focusesComposer: Bool = true) {
        activePostCommentsPresentation = PostCommentsPresentation(
            postID: postID,
            focusesComposer: focusesComposer
        )
    }

    @discardableResult
    func present(destination: AppDestination, currentUserID: String?) -> Bool {
        // Una sola sheet per volta: tutte le `.sheet` stanno sullo STESSO nodo
        // (RootView), quindi chiudere quella aperta e aprirne un'altra nello
        // stesso giro di runloop fa cadere la seconda — il tap su una notifica
        // sembrava non fare niente finché non chiudevi a mano la schermata
        // notifiche. Se qualcosa è presentato, la nuova destinazione parte
        // DOPO l'animazione di chiusura.
        let wasPresentingSheet = hasPresentedSheet
        dismissTransientUI()

        // External quiz invites carry a token that must survive a sign-up
        // detour, so it is stashed before any auth gate.
        if case let .quizInvite(token) = destination {
            pendingQuizInviteToken = token
            selectedTab = .quiz
            if currentUserID == nil {
                runAfterDismiss(wasPresentingSheet) { [weak self] in self?.presentAuth() }
                return false
            }
            return true
        }

        // Public-list share links carry a slug that must survive a sign-up
        // detour, so it is stashed before any auth gate. The Watchlist tab
        // resolves the slug and opens the list detail.
        if case let .publicList(slug) = destination {
            pendingPublicListSlug = slug
            selectedTab = .watchlist
            if currentUserID == nil {
                runAfterDismiss(wasPresentingSheet) { [weak self] in self?.presentAuth() }
                return false
            }
            return true
        }

        if destination.requiresAuthenticatedSession, currentUserID == nil {
            runAfterDismiss(wasPresentingSheet) { [weak self] in self?.presentAuth() }
            return false
        }

        runAfterDismiss(wasPresentingSheet) { [weak self] in
            self?.applyPresentation(destination, currentUserID: currentUserID)
        }
        return true
    }

    /// Esegue `action` subito, oppure dopo l'animazione di chiusura della sheet
    /// che era aperta. 400ms: stessa attesa già usata per il prompt push dopo
    /// la chiusura del tour (RootView.offerPushPromptIfNeeded).
    private func runAfterDismiss(_ wasPresentingSheet: Bool, _ action: @escaping @MainActor () -> Void) {
        guard wasPresentingSheet else {
            action()
            return
        }
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 400_000_000)
            action()
        }
    }

    /// Applica davvero la destinazione. Separata da `present` perché quando una
    /// sheet è già aperta va eseguita dopo la sua chiusura, non nello stesso
    /// giro di runloop.
    private func applyPresentation(_ destination: AppDestination, currentUserID: String?) {
        switch destination {
        case .notifications:
            isNotificationsPresented = true
        case .threads:
            activePresentedSheet = .threads
        case let .thread(id):
            activePresentedSheet = .thread(id: id)
        case .watchlist:
            selectedTab = .watchlist
        case .widgetGuide:
            activePresentedSheet = .widgetGuide
        case .profileInbox:
            activePresentedDestination = .profileInbox
        case let .profile(uid):
            if uid == currentUserID {
                selectedTab = .profile
            } else {
                activePresentedDestination = .profile(uid: uid)
            }
        case let .title(id, focus):
            activePresentedDestination = .title(id: id, focus: focus)
        case let .titlesImport(importId):
            activePresentedDestination = .titlesImport(importId: importId)
        case let .post(id):
            presentPostComments(postID: id, focusesComposer: false)
        case .quizChallenges:
            selectedTab = .quiz
        case .quizInvite:
            break // handled above, before the auth gate
        case .publicList:
            break // handled above, before the auth gate
        case .titleSlug:
            break // risolto in .title da handleIncomingURL, non arriva mai qui
        case let .web(url):
            activePresentedDestination = .web(url)
        }
    }

    /// C'è una sheet (o un fullScreenCover) sullo schermo in questo momento?
    private var hasPresentedSheet: Bool {
        isNotificationsPresented
            || isMenuPresented
            || isSearchPresented
            || isAuthPresented
            || activePostCommentsPresentation != nil
            || activePresentedDestination != nil
            || activePresentedSheet != nil
    }

    func invalidateSocialSurfaces() {
        socialRefreshToken = UUID()
    }

    private func dismissTransientUI() {
        isMenuPresented = false
        isSearchPresented = false
        isAuthPresented = false
        isNotificationsPresented = false
        activePostCommentsPresentation = nil
        activePresentedDestination = nil
        activePresentedSheet = nil
    }
}
