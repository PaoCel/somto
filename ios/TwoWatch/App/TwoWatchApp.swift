import CoreSpotlight
import GoogleSignIn
import SwiftUI
import UIKit

@main
struct TwoWatchApp: App {
    @UIApplicationDelegateAdaptor(SomtoAppDelegate.self) private var appDelegate
    @State private var container = AppContainer()

    var body: some Scene {
        WindowGroup {
            appRoot
        }
    }

    @ViewBuilder
    private var appRoot: some View {
#if DEBUG
        if let screenshotScene = AppStoreScreenshotScene.current {
            AppStoreScreenshotRoot(scene: screenshotScene)
        } else {
            mainRoot
        }
#else
        mainRoot
#endif
    }

    private var mainRoot: some View {
        RootView()
            .environment(container)
            .environment(container.sessionStore)
            .environment(container.shellStore)
            .preferredColorScheme(.dark)
            .onAppear {
                appDelegate.bind(pushCoordinator: container.pushNotifications)
                container.pushNotifications.bind(
                    sessionStore: container.sessionStore,
                    shellStore: container.shellStore
                )
            }
            .onOpenURL { url in
                if GIDSignIn.sharedInstance.handle(url) {
                    return
                }

                Task { @MainActor in
                    await handleIncomingURL(url)
                }
            }
            // Universal links (Safari → app) arrive as a browsing-web user
            // activity, including on cold start. Route them through the same
            // deep-link resolver as custom-scheme URLs.
            .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
                guard let url = activity.webpageURL else { return }
                Task { @MainActor in
                    await handleIncomingURL(url)
                }
            }
            // Tap su un risultato Spotlight. E' un activity type DIVERSO da
            // quello dei link universali: senza questo handler il tap apre
            // l'app e non succede niente. L'identificatore dell'item e' gia' il
            // doc id del titolo, quindi non serve risolvere nessuno slug.
            .onContinueUserActivity(CSSearchableItemActionType) { activity in
                guard let titleID = SpotlightIndexer.titleID(from: activity) else { return }
                _ = container.shellStore.present(
                    destination: .title(id: titleID, focus: nil),
                    currentUserID: container.sessionStore.firebaseUser?.uid
                )
            }
    }

    @MainActor
    private func handleIncomingURL(_ url: URL) async {
        // Un tap su un widget non apre mai l'app di destinazione: iOS consegna
        // l'URL all'app contenitrice, cioe' a noi. Se e' un indirizzo di
        // streaming lo ripassiamo al sistema — che apre Netflix, Apple TV o chi
        // per loro — invece di aprirlo nel browser interno, che era il
        // comportamento di prima e faceva finire dentro Somto chi aveva appena
        // toccato "guarda".
        if StreamingDestinationResolver.isExternalWatchDestination(url) {
            await UIApplication.shared.open(url)
            return
        }

        guard var destination = container.notificationRepository.destinationForURL(url) else {
            return
        }

        // Le pagine pubbliche /film e /serie portano lo slug SEO, non il doc id:
        // va risolto prima di navigare. Se il titolo non si trova (slug vecchio,
        // titolo rimosso) non apriamo una schermata sbagliata: lasciamo perdere
        // il deep link e l'app parte normalmente.
        if case let .titleSlug(slug, focus) = destination {
            guard
                let titleID = try? await container.titleRepository.fetchTitleID(forSlug: slug),
                !titleID.isEmpty
            else {
                return
            }
            destination = .title(id: titleID, focus: focus)
        }

        if destination.requiresAuthenticatedSession {
            var attemptsRemaining = 40
            while container.sessionStore.isLoading, attemptsRemaining > 0 {
                attemptsRemaining -= 1
                try? await Task.sleep(nanoseconds: 150_000_000)
            }
        }

        _ = container.shellStore.present(
            destination: destination,
            currentUserID: container.sessionStore.firebaseUser?.uid
        )
    }
}
